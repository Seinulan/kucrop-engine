// KUCrop: каркас SaaS-приложения — состояние, запросы к серверу, маршруты, тема и язык.
import { LANGS, getLang, setLang, t } from './i18n.js';
import { el, icon, store, toast, reducedMotion } from './ui.js';
import { destroyCharts } from './charts.js';
import { PAGES } from './pages.js';

const KINDS = ['cli', 'crop', 'soil', 'gwt', 'man'];
const NAV = [['overview', 'grid'], ['simulate', 'sprout'], ['files', 'file'], ['model', 'chip'], ['settings', 'sliders']];

export const state = {
  config: null, selected: {}, params: {}, result: null, running: false, error: null,
  offline: false, page: 'overview', simTab: 'crop', justRan: false, themePref: store.get('kucrop.theme', 'system'),
};

/* ---------- сервер ---------- */
export async function api(path, opts = {}) {
  const url = path + (path.includes('?') ? '&' : '?') + 'lang=' + getLang();
  let res;
  try {
    res = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Lang': getLang(), ...(opts.headers || {}) } });
  } catch (e) {
    state.offline = true; renderStatus();
    throw new Error(t('err.server'));
  }
  state.offline = false;
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const entries = (kind) => (state.config && state.config.library[kind]) || [];
export const entry = (kind, id) => entries(kind).find((e) => e.id === id);

function validId(kind, id) {
  if (!id) return false;
  if (kind === 'soil' && state.config.builtin_soils[id]) return true;
  const e = entry(kind, id);
  return Boolean(e && e.ok);
}

export async function loadConfig() {
  state.config = await api('/api/config');
  const saved = store.get('kucrop.selected', {});
  for (const k of KINDS) {
    const want = state.selected[k] || saved[k];
    state.selected[k] = validId(k, want) ? want : state.config.defaults[k];
  }
  const p = { ...store.get('kucrop.params', {}), ...state.params };
  const pl = state.config.planting;
  state.params = {
    startDate: p.startDate && p.startDate >= pl.min && p.startDate <= pl.max ? p.startDate : pl.default,
    gwDepth: p.gwDepth != null && p.gwDepth !== '' ? p.gwDepth : fileGwDepth(),
    irrigation: p.irrigation === 'Irrigated' ? 'Irrigated' : 'Rainfed',
    initWater: p.initWater === 'WP' ? 'WP' : 'FC',
  };
}

export function fileGwDepth() {
  const g = entry('gwt', state.selected.gwt);
  return g && g.summary && g.summary.mode === 1 ? g.summary.depth : '';
}

export function setSelected(kind, id) {
  state.selected[kind] = id;
  if (kind === 'gwt') state.params.gwDepth = fileGwDepth();
  store.set('kucrop.selected', state.selected);
  store.set('kucrop.params', state.params);
}

export function setParam(key, value) {
  state.params[key] = value;
  store.set('kucrop.params', state.params);
}

export async function runSimulation({ quiet = false } = {}) {
  if (!state.config || state.running) return;
  state.running = true; state.error = null;
  render(); renderStatus();
  const g = entry('gwt', state.selected.gwt);
  const body = {
    cliFile: state.selected.cli, cropFile: state.selected.crop, soilFile: state.selected.soil,
    gwtFile: state.selected.gwt, manFile: state.selected.man,
    startDate: state.params.startDate.replace(/-/g, '/'), irrigation: state.params.irrigation, initWater: state.params.initWater,
  };
  if (g && g.summary && g.summary.mode === 1 && state.params.gwDepth !== '') body.gwDepth = state.params.gwDepth;
  try {
    state.result = await api('/api/predict', { method: 'POST', body: JSON.stringify(body) });
    state.justRan = true;
  } catch (e) {
    state.error = e.message;
    if (!quiet) toast(e.message, true);
  } finally {
    state.running = false;
    render(); renderStatus();
    state.justRan = false;
  }
}

/* ---------- тема: плавный круг от кнопки (View Transitions), иначе мягкий переход цветов ---------- */
const systemDark = () => window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
const isDark = () => document.documentElement.dataset.theme === 'dark';

export function setTheme(pref, origin) {
  state.themePref = pref;
  store.set('kucrop.theme', pref);
  const dark = pref === 'dark' || (pref === 'system' && systemDark());
  if (dark === isDark()) { render(); return; }
  const root = document.documentElement;
  const apply = () => { root.dataset.theme = dark ? 'dark' : 'light'; renderThemeBtn(); render(); };
  const r = origin ? origin.getBoundingClientRect() : { left: innerWidth - 60, top: 30, width: 0, height: 0 };
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  if (document.startViewTransition && !reducedMotion()) {
    const vt = document.startViewTransition(apply);
    vt.ready.then(() => {
      const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] },
        { duration: 600, easing: 'cubic-bezier(.4, 0, .2, 1)', pseudoElement: '::view-transition-new(root)' });
    }).catch(() => {});
  } else {
    root.classList.add('theming');
    apply();
    setTimeout(() => root.classList.remove('theming'), 450);
  }
}

if (window.matchMedia) {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.themePref === 'system') setTheme('system'); });
}

function renderThemeBtn() {
  const b = document.getElementById('themeBtn');
  const label = isDark() ? t('theme.to_light') : t('theme.to_dark');
  b.replaceChildren(icon(isDark() ? 'sun' : 'moon'), el('span', { class: 'sr-only', text: label }));
  b.title = label;
}

/* ---------- язык ---------- */
export async function changeLang(code) {
  if (code === getLang()) return;
  setLang(code);
  store.set('kucrop.lang', code);
  applyStatic();
  render();
  try {                                 // тексты сервера (сводки файлов, условия расчёта) - на новом языке
    await loadConfig();
    render();
    if (state.result) await runSimulation({ quiet: true });
  } catch (e) { toast(e.message, true); }
}

function applyStatic() {
  document.documentElement.lang = getLang() === 'kk' ? 'kk' : getLang();
  document.querySelectorAll('[data-t]').forEach((n) => { n.textContent = t(n.dataset.t); });
  const nav = document.getElementById('nav');
  nav.replaceChildren(...NAV.map(([id, ic]) => el('a', { href: `#/${id}`, 'data-page': id }, icon(ic), el('span', { text: t(`nav.${id}`) }))));
  const seg = document.getElementById('langSeg');
  seg.setAttribute('aria-label', t('lang.label'));
  seg.replaceChildren(...LANGS.map((l) => el('button', {
    type: 'button', lang: l.code, title: l.name, 'aria-pressed': String(l.code === getLang()), text: l.short,
    on: { click: () => changeLang(l.code) },
  })));
  renderThemeBtn();
}

/* ---------- статус ---------- */
export function renderStatus() {
  const pill = document.getElementById('statusPill');
  let cls = 'warn', text = t('status.physics');
  if (state.offline) { cls = 'bad'; text = t('status.offline'); }
  else if (state.running) { cls = 'busy'; text = t('status.calc'); }
  else if (state.config && state.config.ai && state.config.ai.available && (!state.result || state.result.ai_yield != null)) { cls = 'ok'; text = t('status.ai'); }
  pill.className = `pill ${cls}`;
  document.getElementById('statusText').textContent = text;
}

/* ---------- маршруты и отрисовка ---------- */
let lastPage = null;
export function render() {
  const page = state.page;
  document.getElementById('pageTitle').textContent = t(`nav.${page}`);
  document.getElementById('pageSub').textContent = t('top.subtitle', { y: (state.config && state.config.target_year) || 2024 });
  document.title = `${t(`nav.${page}`)} · KUCrop`;
  document.querySelectorAll('#nav a').forEach((a) => {
    if (a.dataset.page === page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  destroyCharts();
  const content = document.getElementById('content');
  const node = PAGES[page](ctx);
  if (page !== lastPage) node.classList.add('page');
  content.replaceChildren(node);
  if (node._mounted) node._mounted();
  if (page !== lastPage) window.scrollTo({ top: 0 });
  lastPage = page;
  document.querySelectorAll('.seg#langSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.lang === getLang())));
}

export function go(page) { location.hash = `#/${page}`; }

function onRoute() {
  const id = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
  state.page = PAGES[id] ? id : 'overview';
  document.getElementById('app').classList.remove('nav-open');
  document.getElementById('menuBtn').setAttribute('aria-expanded', 'false');
  render();
}

const ctx = { state, api, entries, entry, setSelected, setParam, runSimulation, loadConfig, render, go, setTheme, changeLang, fileGwDepth };

/* ---------- запуск ---------- */
async function boot() {
  setLang(store.get('kucrop.lang', 'ru'));
  applyStatic();
  const app = document.getElementById('app');
  document.getElementById('menuBtn').addEventListener('click', () => {
    const open = app.classList.toggle('nav-open');
    document.getElementById('menuBtn').setAttribute('aria-expanded', String(open));
  });
  document.getElementById('scrim').addEventListener('click', () => app.classList.remove('nav-open'));
  document.getElementById('themeBtn').addEventListener('click', (e) => setTheme(isDark() ? 'light' : 'dark', e.currentTarget));
  window.addEventListener('hashchange', onRoute);
  onRoute();
  renderStatus();
  try {
    await loadConfig();
    render(); renderStatus();
    await runSimulation({ quiet: true });       // обзор сразу показывает текущий сценарий
  } catch (e) {
    state.error = e.message;
    render(); renderStatus();
  }
  document.body.dataset.ready = '1';
}

boot();
