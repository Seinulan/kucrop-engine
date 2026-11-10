// KUCrop: каркас SaaS-приложения — состояние, запросы к серверу, маршруты, тема и язык.
import { LANGS, getLang, setLang, t } from './i18n.js';
import { el, icon, store, toast, reducedMotion, fmtDateTime } from './ui.js';
import { destroyCharts } from './charts.js';
import { PAGES } from './pages.js';

const KINDS = ['cli', 'crop', 'soil', 'gwt', 'man'];
const NAV = [['overview', 'grid'], ['simulate', 'sprout'], ['history', 'clock'], ['files', 'file'], ['model', 'chip'], ['settings', 'sliders']];
const FILE_PARAM = { cli: 'cliFile', crop: 'cropFile', soil: 'soilFile', gwt: 'gwtFile', man: 'manFile' };

export const state = {
  config: null, selected: {}, params: {}, result: null, running: false, error: null,
  offline: false, page: 'overview', simTab: 'crop', justRan: false, themePref: store.get('kucrop.theme', 'system'),
  user: null, accounts: false, canUpload: true,        // аккаунт: кто вошёл, включены ли аккаунты на сервере
  history: null, historyLoading: false, authTab: 'signin', authBusy: false, authError: null,
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

/* Даты посева задаёт выбранный климатический файл (как в настольном AquaCrop): считать можно любой сезон внутри его рядов. */
export function planting() {
  const e = entry('cli', state.selected.cli);
  return (e && e.summary && e.summary.planting) || { min: '1900-01-01', max: '2100-12-31', default: '2024-05-25' };
}

/** Тот же день и месяц в другом году (29 февраля -> 28 февраля, если года високосного нет). */
export function sameDayInYear(iso, year) {
  const [, m, d] = String(iso).split('-').map(Number);
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Дата, которая гарантированно попадает в период файла: своя - если подходит, иначе тот же день в году по умолчанию. */
export function fitDate(date, pl = planting()) {
  if (date && date >= pl.min && date <= pl.max) return date;
  if (date) {
    const near = sameDayInYear(date, Number(pl.default.slice(0, 4)));
    if (near >= pl.min && near <= pl.max) return near;
  }
  return pl.default;
}

export async function loadConfig() {
  state.config = await api('/api/config');
  state.user = state.config.user || null;
  state.accounts = Boolean(state.config.accounts);
  state.canUpload = state.config.can_upload !== false;
  renderWho();
  const saved = store.get('kucrop.selected', {});
  for (const k of KINDS) {
    const want = state.selected[k] || saved[k];
    state.selected[k] = validId(k, want) ? want : state.config.defaults[k];
  }
  const p = { ...store.get('kucrop.params', {}), ...state.params };
  state.params = {
    startDate: fitDate(p.startDate),
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
  if (kind === 'cli') state.params.startDate = fitDate(state.params.startDate);   // у другого климата другой период
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
    save: !quiet && Boolean(state.user),          // в историю попадают только расчёты, запущенные кнопкой
  };
  if (g && g.summary && g.summary.mode === 1 && state.params.gwDepth !== '') body.gwDepth = state.params.gwDepth;
  try {
    state.result = await api('/api/predict', { method: 'POST', body: JSON.stringify(body) });
    state.justRan = true;
    if (state.result.saved_id) state.history = null;
    if (state.result.save_error && !quiet) toast(state.result.save_error, true);
  } catch (e) {
    state.error = e.message;
    if (!quiet) toast(e.message, true);
  } finally {
    state.running = false;
    render(); renderStatus();
    state.justRan = false;
  }
}

/* ---------- аккаунт ---------- */
async function afterAuthChange() {
  state.history = null;
  await loadConfig();                       // у каждого пользователя свои файлы
  render(); renderStatus();
  await runSimulation({ quiet: true });     // результат на экране должен соответствовать видимым файлам
}

export async function signIn(mode, fields) {
  if (state.authBusy) return;
  state.authBusy = true; state.authError = null; render();
  try {
    const d = await api(mode === 'signup' ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: JSON.stringify(fields) });
    toast(t('auth.welcome', { name: d.user.name || d.user.email }));
    state.authBusy = false;
    await afterAuthChange();
  } catch (e) {
    state.authBusy = false; state.authError = e.message;
    render();
  }
}

export async function signOut() {
  try {
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
    toast(t('auth.bye'));
    await afterAuthChange();
  } catch (e) { toast(e.message, true); }
}

/* ---------- история расчётов ---------- */
export async function loadHistory() {
  if (state.historyLoading) return;
  state.historyLoading = true;
  try { state.history = await api('/api/simulations'); } catch (e) { state.history = { error: e.message, items: [], total: 0 }; }
  state.historyLoading = false;
  if (state.page === 'history' || state.page === 'account') render();
}

/** Открыть сохранённый расчёт: его параметры становятся текущими, результат показывается как был сохранён. */
export async function openSaved(id) {
  try {
    const it = await api(`/api/simulations/item?id=${encodeURIComponent(id)}`);
    const p = it.params || {};
    for (const k of KINDS) if (validId(k, p[FILE_PARAM[k]])) state.selected[k] = p[FILE_PARAM[k]];
    state.params = {
      startDate: fitDate(String(p.startDate || '').replace(/\//g, '-')),
      gwDepth: p.gwDepth != null ? p.gwDepth : fileGwDepth(),
      irrigation: p.irrigation === 'Irrigated' ? 'Irrigated' : 'Rainfed',
      initWater: p.initWater === 'WP' ? 'WP' : 'FC',
    };
    store.set('kucrop.selected', state.selected);
    store.set('kucrop.params', state.params);
    state.result = it.result; state.error = null; state.simTab = 'crop';
    toast(t('hist.opened', { d: fmtDateTime(it.created_at) }));
    if (state.page === 'simulate') render(); else go('simulate');
    renderStatus();
  } catch (e) { toast(e.message, true); }
}

export async function deleteSaved(id) {
  try {
    await api(id === 'all' ? '/api/simulations?all=1' : `/api/simulations?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast(t(id === 'all' ? 'hist.cleared' : 'hist.deleted'));
    state.history = null;
    render();
  } catch (e) { toast(e.message, true); }
}

function renderWho() {
  const u = state.user;
  const initial = u ? (u.name || u.email).trim().charAt(0).toUpperCase() : t('guest.initial');
  const label = u ? (u.name || u.email) : t('guest.name');
  document.getElementById('whoAvatar').textContent = initial;
  document.getElementById('whoName').textContent = label;
  document.getElementById('whoSub').textContent = u ? u.email : t(state.accounts || !state.config ? 'guest.sub' : 'guest.sub_off');
  const top = document.getElementById('topAvatar');
  top.textContent = initial;
  top.title = `${t('nav.account')}: ${label}`;
  top.setAttribute('aria-label', top.title);
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
  renderWho();
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
  const cli = state.config && entry('cli', state.selected.cli);
  document.getElementById('pageSub').textContent = cli && cli.summary
    ? t('top.subtitle', { st: cli.summary.station, y: String(state.params.startDate || '').slice(0, 4) }) : '';
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
  state.authError = null;
  document.getElementById('app').classList.remove('nav-open');
  document.getElementById('menuBtn').setAttribute('aria-expanded', 'false');
  render();
}

const ctx = { state, api, entries, entry, setSelected, setParam, runSimulation, loadConfig, render, go, setTheme, changeLang, fileGwDepth, planting, sameDayInYear, fitDate,
  signIn, signOut, loadHistory, openSaved, deleteSaved };

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
