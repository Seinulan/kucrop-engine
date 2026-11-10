// Мелкие помощники интерфейса: элементы, иконки, числа и даты по языку, уведомления, хранилище.
import { getLang, locale } from './i18n.js';

// казахские даты пишем сами: в некоторых сборках браузера нет данных ICU для kk
const KK_MONTHS = ['қаңтар', 'ақпан', 'наурыз', 'сәуір', 'мамыр', 'маусым', 'шілде', 'тамыз', 'қыркүйек', 'қазан', 'қараша', 'желтоқсан'];
const KK_SHORT = ['қаң.', 'ақп.', 'нау.', 'сәу.', 'мам.', 'мау.', 'шіл.', 'там.', 'қыр.', 'қаз.', 'қар.', 'жел.'];
const numLocale = () => (getLang() === 'kk' ? 'ru-RU' : locale());

export function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'text') node.textContent = v;
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : String(kid));
  }
  return node;
}

const ICONS = {
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  sprout: '<path d="M12 21v-8"/><path d="M12 13c0-4.5 3-7.5 8-7.5 0 5-3 8-8 8"/><path d="M12 15c0-3.5-2.5-6-7-6 0 4 2.5 6.5 7 6.5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M9.5 2.5v3.5M14.5 2.5v3.5M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"/><rect x="10" y="10" width="4" height="4" rx=".8"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a7.5 7.5 0 1 0 10.5 10.5z"/>',
  upload: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 3.5l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  play: '<path d="M8 5.5l11 6.5-11 6.5z"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  drop: '<path d="M12 3.5s6.5 7 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 10.5 12 3.5 12 3.5z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  user: '<circle cx="12" cy="8.5" r="3.7"/><path d="M4.5 20.5c1-3.8 4-5.8 7.5-5.8s6.5 2 7.5 5.8"/>',
  logout: '<path d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 8l-4 4 4 4M6 12h9"/>',
  open: '<path d="M5 12h13M12.5 6.5L18 12l-5.5 5.5"/>',
};

export function icon(name, cls = '') {
  const w = document.createElement('span');
  w.innerHTML = `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return w.firstChild;
}

export function num(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  return new Intl.NumberFormat(numLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(v));
}

export function signed(v, digits = 2) {
  if (!Number.isFinite(Number(v))) return '—';
  return (v > 0 ? '+' : v < 0 ? '−' : '±') + num(Math.abs(v), digits);
}

export function fmtDate(iso, opts = { day: 'numeric', month: 'short' }) {
  if (!iso) return '—';
  const d = new Date(String(iso).replace(/\//g, '-').slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return String(iso);
  if (getLang() === 'kk') {
    const m = (opts.month === 'long' ? KK_MONTHS : KK_SHORT)[d.getMonth()];
    return `${d.getDate()} ${m}${opts.year ? ` ${d.getFullYear()} ж.` : ''}`;
  }
  try { return new Intl.DateTimeFormat(locale(), opts).format(d); } catch (e) { return d.toISOString().slice(0, 10); }
}

/** Дата и время события (например, когда сохранён расчёт) в часовом поясе пользователя. */
export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '—';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (getLang() === 'kk') return `${d.getDate()} ${KK_SHORT[d.getMonth()]} ${d.getFullYear()} ж., ${hm}`;
  try { return `${new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', year: 'numeric' }).format(d)}, ${hm}`; } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
}

export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* хранилище недоступно - работаем без него */ }
  },
};

export function toast(text, bad = false) {
  const box = document.getElementById('toasts');
  const node = el('div', { class: `toast${bad ? ' bad' : ''}`, role: bad ? 'alert' : 'status' }, icon(bad ? 'alert' : 'check'), el('span', { text }));
  box.append(node);
  setTimeout(() => node.remove(), bad ? 7000 : 3500);
}

export const reducedMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

// число «дорастает» до значения: единственная анимация результата вместе с полосой сезона
export function countUp(node, to, digits = 2, ms = 750) {
  if (reducedMotion() || !Number.isFinite(to)) { node.textContent = num(to, digits); return; }
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    node.textContent = num(to * (1 - Math.pow(1 - k, 3)), digits);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
