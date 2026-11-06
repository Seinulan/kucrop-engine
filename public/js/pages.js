// Страницы приложения. Каждая страница — функция (ctx) => DOM-узел; ctx даёт состояние и действия из app.js.
import { LANGS, getLang, t } from './i18n.js';
import { el, icon, num, signed, fmtDate, countUp, toast } from './ui.js';
import { canopyChart, rainChart } from './charts.js';

const KIND_ORDER = ['cli', 'crop', 'soil', 'gwt', 'man'];
const KIND_EXT = { cli: '.CLI', crop: '.CRO', soil: '.SOL', gwt: '.GWT', man: '.MAN', tnx: '.Tnx', eto: '.ETo', plu: '.PLU' };
const KIND_NAME = { cli: 'env.climate', crop: 'env.crop', soil: 'env.soil', gwt: 'env.gw', man: 'env.man' };
const periodText = (r) => { const [a, b] = r.period.split(' - '); return `${fmtDate(a)} – ${fmtDate(b)}`; };
const baseName = (id) => String(id || '').replace('aquacrop:', '').split('/').pop();

function head(title, lead, ...actions) {
  return el('div', { class: 'head' },
    el('div', {}, el('h1', { text: title }), lead ? el('p', { text: lead }) : null),
    actions.length ? el('div', { class: 'head-actions' }, actions) : null);
}

function runButton(ctx, label, cls = 'btn') {
  const busy = ctx.state.running;
  return el('button', { type: 'button', class: cls, disabled: busy || !ctx.state.config, on: { click: () => ctx.runSimulation() } },
    busy ? el('span', { class: 'spin' }) : icon('play'), busy ? t('sim.running') : label);
}

function errorPanel(ctx) {
  return el('div', { class: 'panel err' },
    el('h3', {}, icon('alert'), t('err.title')),
    el('p', { text: ctx.state.error }),
    el('button', { type: 'button', class: 'btn', on: { click: () => (ctx.state.config ? ctx.runSimulation() : location.reload()) } }, icon('refresh'), t('err.retry')));
}

/* ---------- полоса KPI ---------- */
function kpis(ctx) {
  const r = ctx.state.result;
  const wb = r && r.water_balance;
  const cell = (cls, label, value, unit, sub) => el('div', { class: `kpi ${cls}` },
    el('div', { class: 'kpi-label' }, el('i'), label),
    el('div', { class: 'kpi-value' }, value, unit ? el('small', { text: unit }) : null),
    el('div', { class: 'kpi-sub', text: sub || ' ', title: sub || '' }));
  const ai = r && r.ai_yield != null;
  const gwMode = r && ctx.entry('gwt', r.files.gwt);
  const depth = ctx.state.params.gwDepth;
  return el('section', { class: 'kpis', 'aria-label': t('ov.title') },
    cell('k-wheat', t('kpi.yield'), r ? num(r.yield_tonne_ha) : '—', t('u.tha'), r ? periodText(r) : ''),
    cell('k-leaf', t('kpi.ai'), ai ? num(r.ai_yield) : '—', ai ? t('u.tha') : '',
      ai ? t('kpi.diff', { d: signed(r.ai_yield - r.yield_tonne_ha) }) : r ? t('kpi.ai_off') : ''),
    cell('k-water', t('kpi.rain'), wb ? num(wb.rain, 0) : '—', t('u.mm'), t('kpi.rain_sub')),
    cell('k-soil', t('kpi.cr'), wb ? num(wb.capillary_rise, 1) : '—', t('u.mm'),
      gwMode && gwMode.summary && gwMode.summary.mode === 0 ? t('kpi.cr_none') : depth !== '' ? t('kpi.cr_sub', { d: num(depth, 2) }) : ''));
}

/* ---------- карточка урожая с полосой сезона ---------- */
function hero(ctx) {
  const r = ctx.state.result;
  const loading = ctx.state.running && !r;
  const node = el('section', { class: `hero${loading ? ' loading' : ''}`, 'aria-live': 'polite' });
  if (!r) {
    node.append(el('div', { class: 'hero-top' }, el('div', {}, el('div', { class: 'hero-crop', text: baseName(ctx.state.selected.crop) || 'KUCrop' }),
      el('div', { class: 'hero-period', text: t('calc.wait') }))),
    el('div', { class: 'hero-label', text: t('hero.label') }),
    el('div', { class: 'hero-num' }, el('b', { text: '0,00' }), el('span', { text: t('u.tha') })),
    el('div', { class: 'strip' }, el('div', { class: 'strip-bar' })),
    el('div', { class: 'hero-facts' }, ['hero.biomass', 'hero.hi', 'hero.cc'].map((k) => el('div', {}, el('span', { text: t(k) }), el('b', { text: '0,0' })))));
    return node;
  }
  const [start, end] = r.period.split(' - ');
  const pd = r.production_details || {};
  const value = el('b', { text: num(r.yield_tonne_ha) });
  const grow = ctx.state.justRan;
  if (grow) countUp(value, r.yield_tonne_ha, 2);

  const cc = (r.charts && r.charts.canopy_cover) || [];
  const delay = Math.max(2, Math.min(8, 700 / Math.max(1, cc.length)));
  const bars = cc.map((v, i) => el('i', {
    title: `${fmtDate(r.charts.dates[i])}: ${num(v, 0)}%`,
    style: `align-self:flex-end;height:${Math.max(7, v)}%;background:color-mix(in srgb, #7fd19c ${Math.round(18 + v * 0.82)}%, rgba(255,255,255,.08));${grow ? `animation-delay:${Math.round(i * delay)}ms` : ''}`,
  }));
  const aiLine = r.ai_yield != null
    ? el('div', { class: 'hero-ai' }, icon('spark'), el('span', {},
        t('hero.ai', { v: num(r.ai_yield), ms: num(r.ai_ms, r.ai_ms < 1 ? 3 : 1) }), ' · ', t('hero.physics', { s: num(r.physics_ms / 1000, 2) }),
        r.ai_note ? el('span', { text: ' · ' + t('hero.ai_flag', { r: r.ai_note }) }) : null))
    : el('div', { class: 'hero-ai off' }, icon('info'), el('span', { text: t('hero.ai_off', { r: r.ai_error || '—' }) }));

  node.append(
    el('div', { class: 'hero-top' },
      el('div', {}, el('div', { class: 'hero-crop', text: baseName(r.files.crop) }),
        el('div', { class: 'hero-period', text: `${fmtDate(start, { day: 'numeric', month: 'long' })} – ${fmtDate(end, { day: 'numeric', month: 'long', year: 'numeric' })}` })),
      el('span', { class: 'hero-tag', text: r.irrigation === 'Irrigated' ? t('sim.irrigated') : t('sim.rainfed') })),
    el('div', { class: 'hero-label', text: t('hero.label') }),
    el('div', { class: 'hero-num' }, value, el('span', { text: t('u.tha') })),
    el('div', { class: `strip${grow ? ' grow' : ''}`, role: 'img', 'aria-label': t('hero.strip') },
      el('div', { class: 'strip-bar' }, bars),
      el('div', { class: 'strip-axis' }, el('span', { text: fmtDate(start) }), el('span', { text: fmtDate(end) })),
      el('div', { class: 'strip-cap', text: t('hero.strip') })),
    el('div', { class: 'hero-facts' },
      el('div', {}, el('span', { text: t('hero.biomass') }), el('b', { text: `${num(pd.actual_biomass)} ${t('u.tha')}` })),
      el('div', {}, el('span', { text: t('hero.hi') }), el('b', { text: `${num(pd.harvest_index, 1)}%` })),
      el('div', {}, el('span', { text: t('hero.cc') }), el('b', { text: `${num(pd.max_canopy_cover, 0)}%` }))),
    aiLine);
  return node;
}

function chartPanel(title, make, r, tall) {
  const canvas = el('canvas');
  const panel = el('section', { class: 'panel' },
    el('div', { class: 'panel-head' }, el('h3', { text: title })),
    el('div', { class: `chart-box${tall ? ' tall' : ''}` }, r ? canvas : el('p', { class: 'panel-sub', text: t('calc.wait') })));
  panel._mount = () => r && make(canvas, r);
  return panel;
}

function mountAll(root, panels) {
  root._mounted = () => panels.forEach((p) => p && p._mount && p._mount());
  return root;
}

function gwText(ctx, r) {
  const g = ctx.entry('gwt', r.files.gwt);
  const mode = g && g.summary ? g.summary.mode : null;
  if (mode === 0) return t('kpi.cr_none');
  if (mode === 1) return `${num(ctx.state.params.gwDepth !== '' ? ctx.state.params.gwDepth : g.summary.depth, 2)} ${t('u.m')}`;
  return (g && g.summary && g.summary.text) || baseName(r.files.gwt);
}

/* ================= Обзор ================= */
function overview(ctx) {
  const s = ctx.state;
  const y = (s.config && s.config.target_year) || 2024;
  const root = el('div', {});
  root.append(head(t('ov.title'), t('ov.lead', { y }),
    el('a', { class: 'btn', href: '#/simulate' }, icon('sliders'), t('ov.change')),
    runButton(ctx, t('ov.rerun'), 'btn primary')));
  if (s.error && !s.result) { root.append(errorPanel(ctx)); return root; }
  root.append(kpis(ctx));

  const canopy = chartPanel(t('chart.canopy'), canopyChart, s.result, true);
  const r = s.result, p = s.params;
  const scenItems = r ? [
    [t('env.crop'), baseName(r.files.crop)], [t('env.soil'), baseName(r.files.soil)], [t('env.climate'), baseName(r.files.cli)],
    [t('scen.gw'), gwText(ctx, r)],
    [t('scen.sowing'), fmtDate(r.period.split(' - ')[0], { day: 'numeric', month: 'long' })],
    [t('scen.harvest'), fmtDate(r.period.split(' - ')[1], { day: 'numeric', month: 'long' })],
    [t('scen.irr'), p.irrigation === 'Irrigated' ? t('sim.irrigated') : t('sim.rainfed')],
    [t('scen.init'), p.initWater === 'WP' ? t('sim.wp') : t('sim.fc')],
  ] : [];
  const read = [['--wheat-fill', 'read.1'], ['--leaf-fill', 'read.2'], ['--soil', 'read.3'], ['--water-fill', 'read.4']];
  root.append(el('div', { class: 'grid' },
    el('div', { class: 'c5' }, hero(ctx)),
    el('div', { class: 'c7' }, canopy),
    el('section', { class: 'panel c7' },
      el('div', { class: 'panel-head' }, el('h3', { text: t('scen.title') }), el('a', { class: 'btn ghost', href: '#/simulate' }, t('ov.change'))),
      r ? el('div', { class: 'scen' }, scenItems.map(([k, v]) => el('div', {}, el('span', { text: k }), el('b', { text: v, title: v }))))
        : el('p', { class: 'panel-sub', text: t('calc.wait') })),
    el('section', { class: 'panel c5' },
      el('div', { class: 'panel-head' }, el('h3', { text: t('read.title') })),
      el('ul', { class: 'read' }, read.map(([c, k]) => el('li', {}, el('i', { style: `background:var(${c})` }), el('span', { text: t(k) })))))));
  return mountAll(root, [canopy]);
}

/* ================= Симуляция ================= */
function fileSelect(ctx, kind) {
  const s = ctx.state;
  const opts = ctx.entries(kind).map((e) => el('option', { value: e.id, disabled: !e.ok, selected: e.id === s.selected[kind],
    text: `${e.name}${e.source === 'user' ? ` (${t('files.user')})` : ''}${e.ok ? '' : ' ✗'}` }));
  if (kind === 'soil') {
    for (const [id, label] of Object.entries(s.config.builtin_soils)) opts.push(el('option', { value: id, text: label, selected: id === s.selected.soil }));
  }
  const id = `f_${kind}`;
  const e = ctx.entry(kind, s.selected[kind]);
  const sel = el('select', { class: 'ctl', id, on: { change: (ev) => { ctx.setSelected(kind, ev.target.value); ctx.render(); } } }, opts);
  return el('div', { class: 'field' }, el('label', { for: id, text: t(KIND_NAME[kind]) }), sel,
    e && e.summary ? el('small', { text: e.summary.text }) : null);
}

function seg(options, value, onPick, label) {
  return el('div', { class: 'seg wide', role: 'group', 'aria-label': label }, options.map(([v, text]) =>
    el('button', { type: 'button', 'aria-pressed': String(v === value), text, on: { click: () => onPick(v) } })));
}

function paramsPanel(ctx) {
  const s = ctx.state, c = s.config, p = s.params;
  const crop = ctx.entry('crop', s.selected.crop);
  const gwt = ctx.entry('gwt', s.selected.gwt);
  const constGw = gwt && gwt.summary && gwt.summary.mode === 1;
  const cs = crop && crop.summary;
  const maturity = () => {
    if (!cs) return '—';
    if (cs.calendar && cs.calendar.indexOf('GDD') >= 0) return t('sim.cycle_gdd');
    const d = new Date(p.startDate + 'T00:00:00'); d.setDate(d.getDate() + cs.cycle_days);
    return `${fmtDate(d.toISOString().slice(0, 10), { day: 'numeric', month: 'long' })}, ${t('sim.cycle', { n: cs.cycle_days })}`;
  };
  const matOut = el('input', { class: 'ctl', id: 'p_mat', readonly: true, value: maturity() });
  const date = el('input', { class: 'ctl', id: 'p_date', type: 'date', min: c.planting.min, max: c.planting.max, value: p.startDate,
    on: { change: (e) => { if (e.target.value) { ctx.setParam('startDate', e.target.value); matOut.value = maturity(); } } } });
  const gw = el('input', { class: 'ctl', id: 'p_gw', type: 'number', step: '0.1', min: c.groundwater.valid[0], max: c.groundwater.valid[1],
    value: constGw ? p.gwDepth : '', disabled: !constGw, inputMode: 'decimal',
    on: { change: (e) => ctx.setParam('gwDepth', e.target.value) } });
  return el('section', { class: 'panel' },
    el('div', { class: 'group' },
      el('h4', {}, el('span', { text: t('sim.files') }), el('a', { href: '#/files', text: t('sim.manage') })),
      KIND_ORDER.map((k) => fileSelect(ctx, k))),
    el('div', { class: 'group' },
      el('h4', { text: t('sim.season') }),
      el('div', { class: 'field' }, el('label', { for: 'p_date', text: t('sim.sowing') }), date,
        el('small', { text: t('sim.window', { a: fmtDate(c.planting.min, { day: 'numeric', month: 'long' }), b: fmtDate(c.planting.max, { day: 'numeric', month: 'long' }) }) })),
      el('div', { class: 'field' }, el('label', { for: 'p_mat', text: t('sim.maturity') }), matOut)),
    el('div', { class: 'group' },
      el('h4', { text: t('sim.water') }),
      el('div', { class: 'field' }, el('label', { for: 'p_gw', text: t('sim.gw') }), gw,
        el('small', { text: constGw ? t('sim.gw_hint', { d: num(gwt.summary.depth, 2), a: c.groundwater.min, b: c.groundwater.max }) : t('sim.gw_off') })),
      el('div', { class: 'field' }, el('span', { class: 'label', text: t('sim.irr') }),
        seg([['Rainfed', t('sim.rainfed')], ['Irrigated', t('sim.irrigated')]], p.irrigation, (v) => { ctx.setParam('irrigation', v); ctx.render(); }, t('sim.irr'))),
      el('div', { class: 'field' }, el('span', { class: 'label', text: t('sim.init') }),
        seg([['FC', t('sim.fc')], ['WP', t('sim.wp')]], p.initWater, (v) => { ctx.setParam('initWater', v); ctx.render(); }, t('sim.init')))),
    el('div', { class: 'group' }, runButton(ctx, t('sim.run'), 'btn primary big')));
}

function waterBalance(r) {
  const wb = r.water_balance;
  const ins = [['wb.rain', wb.rain, '--water-fill'], ['wb.irrigation', wb.irrigation, '--water'], ['wb.cr', wb.capillary_rise, '--soil']];
  const outs = [['wb.tr', wb.transpiration, '--leaf-fill'], ['wb.es', wb.evaporation, '--wheat-fill'], ['wb.runoff', wb.runoff, '--muted'], ['wb.deep', wb.deep_percolation, '--faint']];
  const sumIn = ins.reduce((a, x) => a + x[1], 0), sumOut = outs.reduce((a, x) => a + x[1], 0);
  const max = Math.max(sumIn, sumOut, 1);
  const bar = (items, total) => el('div', { class: 'wb-bar', style: `width:${(total / max) * 100}%` },
    items.filter((x) => x[1] > 0).map(([k, v, c]) => el('i', { style: `flex-grow:${v};background:var(${c})`, title: `${t(k)}: ${num(v, 1)} ${t('u.mm')}` })));
  const legend = (items) => items.map(([k, v, c]) => el('div', {}, el('i', { style: `background:var(${c})` }), el('span', { text: t(k) }), el('b', { text: `${num(v, 1)} ${t('u.mm')}` })));
  return el('div', {},
    el('div', { class: 'wb-row' }, el('span', { text: t('wb.in') }), el('div', {}, bar(ins, sumIn)), el('b', { text: num(sumIn, 0) })),
    el('div', { class: 'wb-row' }, el('span', { text: t('wb.out') }), el('div', {}, bar(outs, sumOut)), el('b', { text: num(sumOut, 0) })),
    el('div', { class: 'legend' }, legend(ins), legend(outs),
      el('div', {}, el('i', { style: 'background:transparent;border:1px solid var(--line-strong)' }), el('span', { text: t('wb.infl') }), el('b', { text: `${num(wb.infiltrated, 1)} ${t('u.mm')}` }))),
    el('p', { class: 'note', text: t('wb.note') }));
}

function production(r) {
  const pd = r.production_details;
  return el('div', {},
    el('div', { class: 'tiles' },
      el('div', { class: 'tile' }, el('span', { text: t('prod.biomass') }), el('b', { text: num(pd.actual_biomass) }), el('small', { text: t('u.tha') })),
      el('div', { class: 'tile' }, el('span', { text: t('prod.hi') }), el('b', { text: `${num(pd.harvest_index, 1)}%` })),
      el('div', { class: 'tile' }, el('span', { text: t('prod.potential') }), el('b', { text: num(pd.yield_potential) }), el('small', { text: t('u.tha') })),
      el('div', { class: 'tile' }, el('span', { text: t('prod.cc') }), el('b', { text: `${num(pd.max_canopy_cover, 0)}%` }))),
    el('p', { class: 'note', text: t('prod.note') }));
}

function conditions(r) {
  const e = r.environment;
  const [a, b] = r.period.split(' - ');
  const period = `${fmtDate(a, { day: 'numeric', month: 'long', year: 'numeric' })} – ${fmtDate(b, { day: 'numeric', month: 'long', year: 'numeric' })}`;
  const rows = [['env.engine', e.engine], ['env.location', r.location], ['env.period', period], ['env.climate', e.climate], ['env.crop', e.crop],
    ['env.soil', e.soil], ['env.gw', e.groundwater], ['env.man', e.management], ['env.init', e.initial_water]];
  return el('div', {},
    el('dl', { class: 'dl' }, rows.map(([k, v]) => [el('dt', { text: t(k) }), el('dd', { text: v })])),
    e.not_modeled && e.not_modeled.length ? el('div', { class: 'callout' }, icon('info'),
      el('div', {}, el('b', { text: t('env.not_modeled') }), el('ul', {}, e.not_modeled.map((x) => el('li', { text: x }))))) : null,
    r.warnings && r.warnings.length ? el('div', { class: 'callout bad' }, icon('alert'),
      el('div', {}, el('b', { text: t('env.warnings') }), el('ul', {}, r.warnings.map((x) => el('li', { text: x }))))) : null);
}

function simulate(ctx) {
  const s = ctx.state;
  const root = el('div', {});
  root.append(head(t('nav.simulate'), t('sim.lead')));
  if (!s.config) { root.append(s.error ? errorPanel(ctx) : el('p', { class: 'panel-sub', text: t('calc.wait') })); return root; }
  const r = s.result;
  const tabs = [['crop', 'tab.crop'], ['rain', 'tab.rain'], ['wb', 'tab.wb'], ['prod', 'tab.prod'], ['env', 'tab.env']];
  const body = el('div', {});
  const canvas = el('canvas');
  const showTab = () => {
    body.replaceChildren();
    if (!r) { body.append(el('p', { class: 'panel-sub', text: t('calc.wait') })); return; }
    if (s.simTab === 'crop' || s.simTab === 'rain') {
      body.append(el('div', { class: 'chart-box' }, canvas));
      (s.simTab === 'crop' ? canopyChart : rainChart)(canvas, r);
    } else if (s.simTab === 'wb') body.append(waterBalance(r));
    else if (s.simTab === 'prod') body.append(production(r));
    else body.append(conditions(r));
  };
  const tabBar = el('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, k]) => el('button', {
    type: 'button', role: 'tab', 'aria-selected': String(s.simTab === id), text: t(k),
    on: { click: () => { s.simTab = id; ctx.render(); } },
  })));
  root.append(el('div', { class: 'grid' },
    el('div', { class: 'c4' }, paramsPanel(ctx)),
    el('div', { class: 'c8' }, el('div', { class: 'sticky-col', style: 'display:flex;flex-direction:column;gap:18px' },
      s.error ? errorPanel(ctx) : null,
      hero(ctx),
      el('section', { class: 'panel' }, tabBar, body)))));
  root._mounted = showTab;
  return root;
}

/* ================= Файлы ================= */
async function uploadFiles(ctx, list) {
  for (const f of Array.from(list || [])) {
    try {
      const b64 = await new Promise((resolve, reject) => {
        const rd = new FileReader();
        rd.onload = () => resolve(String(rd.result).split(',')[1] || '');
        rd.onerror = () => reject(new Error(f.name));
        rd.readAsDataURL(f);
      });
      const d = await ctx.api('/api/files', { method: 'POST', body: JSON.stringify({ name: f.name, content_b64: b64 }) });
      toast(t('files.uploaded', { name: f.name }) + (d.note ? ` (${d.note})` : ''));
    } catch (e) {
      toast(`${f.name}: ${e.message}`, true);
    }
  }
  await ctx.loadConfig();
  ctx.render();
}

async function deleteFile(ctx, kind, e) {
  if (!confirm(t('files.confirm_delete', { name: e.name }))) return;
  try {
    await ctx.api(`/api/files?id=${encodeURIComponent(e.id)}`, { method: 'DELETE' });
    toast(t('files.deleted', { name: e.name }));
    if (ctx.state.selected[kind] === e.id) ctx.setSelected(kind, ctx.state.config.defaults[kind]);
    await ctx.loadConfig();
    ctx.render();
  } catch (err) { toast(err.message, true); }
}

function fileRow(ctx, kind, e, selectable = true) {
  const on = selectable && ctx.state.selected[kind] === e.id;
  const use = el('button', { type: 'button', class: 'file-use', disabled: !selectable || !e.ok, title: on ? t('files.in_use') : t('files.use'),
    'aria-pressed': String(on), on: { click: () => { ctx.setSelected(kind, e.id); ctx.render(); } } },
    icon('check'), el('span', { class: 'sr-only', text: on ? t('files.in_use') : t('files.use') }));
  const actions = el('div', { class: 'file-actions' });
  if (!e.builtinProfile) {
    actions.append(el('a', { class: 'icon-btn', href: `/api/files/download?id=${encodeURIComponent(e.id)}`, title: t('files.download') },
      icon('download'), el('span', { class: 'sr-only', text: t('files.download') })));
    if (e.source === 'user') {
      actions.append(el('button', { type: 'button', class: 'icon-btn danger', title: t('files.delete'), on: { click: () => deleteFile(ctx, kind, e) } },
        icon('trash'), el('span', { class: 'sr-only', text: t('files.delete') })));
    }
  }
  return el('div', { class: `file${on ? ' on' : ''}${e.ok ? '' : ' broken'}` },
    selectable ? use : el('span', { style: 'width:22px' }),
    el('div', { style: 'min-width:0' },
      el('div', { class: 'file-name' }, e.name,
        e.builtinProfile ? el('span', { class: 'badge', text: t('files.profile') })
          : el('span', { class: `badge${e.source === 'user' ? ' user' : ''}`, text: e.source === 'user' ? t('files.user') : t('files.builtin') }),
        on ? el('span', { class: 'badge on', text: t('files.in_use') }) : null),
      el('div', { class: `file-sum${e.ok ? '' : ' bad'}`, text: e.ok ? (e.summary && e.summary.text) || '' : `${t('files.broken')}: ${e.error}` })),
    actions);
}

function files(ctx) {
  const s = ctx.state;
  const root = el('div', {});
  const input = el('input', { type: 'file', multiple: true, class: 'sr-only', id: 'upl', accept: Object.values(KIND_EXT).join(','),
    on: { change: (ev) => uploadFiles(ctx, ev.target.files) } });
  root.append(head(t('nav.files'), t('files.lead')));
  if (!s.config) { root.append(s.error ? errorPanel(ctx) : el('p', { class: 'panel-sub', text: t('calc.wait') })); return root; }
  const zone = el('div', { class: 'upload-zone' }, icon('upload'), el('p', { text: t('files.upload_hint') }), input,
    el('label', { for: 'upl', class: 'btn primary', role: 'button', tabindex: '0', on: { keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } } },
      icon('upload'), t('files.upload')));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('drag'); uploadFiles(ctx, e.dataTransfer.files); });
  root.append(zone);
  for (const kind of KIND_ORDER) {
    const list = ctx.entries(kind).map((e) => fileRow(ctx, kind, e));
    if (kind === 'soil') {
      for (const [id, label] of Object.entries(s.config.builtin_soils)) {
        list.push(fileRow(ctx, kind, { id, name: label, ok: true, builtinProfile: true, summary: null }));
      }
    }
    root.append(el('section', { class: 'kind' },
      el('div', { class: 'kind-head' }, el('h3', { text: t(KIND_NAME[kind]) }), el('span', { class: 'ext', text: KIND_EXT[kind] }),
        el('span', { class: 'cnt', text: t('files.count', { n: list.length }) })),
      el('div', { class: 'files' }, list)));
  }
  const series = ['tnx', 'eto', 'plu'].flatMap((k) => ctx.entries(k).map((e) => fileRow(ctx, k, e, false)));
  root.append(el('section', { class: 'kind' },
    el('div', { class: 'kind-head' }, el('h3', { text: t('files.series') }), el('span', { class: 'ext', text: '.Tnx .ETo .PLU' }),
      el('span', { class: 'cnt', text: t('files.count', { n: series.length }) })),
    el('div', { class: 'files' }, series)));
  return root;
}

/* ================= ИИ-модель ================= */
function featLabel(name) {
  if (name.startsWith('crop_')) return t('feat.crop', { x: name.slice(5) });
  if (name.startsWith('soil_')) return t('feat.soil', { x: name.slice(5) });
  return t(`feat.${name}`);
}

function model(ctx) {
  const s = ctx.state;
  const root = el('div', {});
  root.append(head(t('nav.model'), t('model.lead')));
  const ai = s.config && s.config.ai;
  if (!ai) { root.append(s.error ? errorPanel(ctx) : el('p', { class: 'panel-sub', text: t('calc.wait') })); return root; }
  if (!ai.available) {
    root.append(el('div', { class: 'panel err' }, el('h3', {}, icon('alert'), t('status.physics')), el('p', { text: ai.reason })));
    return root;
  }
  const m = ai.metrics || {};
  const physMs = ai.speed && ai.speed.physics_s_per_run ? ai.speed.physics_s_per_run * 1000 : (s.result && s.result.physics_ms) || null;
  const onnxMs = (ai.speed && ai.speed.onnx_ms_per_prediction) || (s.result && s.result.ai_ms) || null;
  const times = physMs && onnxMs ? Math.round(physMs / onnxMs) : null;
  const y = ai.target_year;

  root.append(el('section', { class: 'kpis' },
    el('div', { class: 'kpi k-leaf' }, el('div', { class: 'kpi-label' }, el('i'), t('model.r2')), el('div', { class: 'kpi-value', text: num(m.r2_test, 4) }), el('div', { class: 'kpi-sub', text: t('model.r2_sub') })),
    el('div', { class: 'kpi k-wheat' }, el('div', { class: 'kpi-label' }, el('i'), t('model.rmse')), el('div', { class: 'kpi-value' }, num(m.rmse_test_t_ha), el('small', { text: t('u.tha') })), el('div', { class: 'kpi-sub', text: t('model.rmse_sub') })),
    el('div', { class: 'kpi k-water' }, el('div', { class: 'kpi-label' }, el('i'), t('model.n')), el('div', { class: 'kpi-value', text: num(ai.n_samples, 0) }), el('div', { class: 'kpi-sub', text: t('model.n_sub', { y }) })),
    el('div', { class: 'kpi k-soil' }, el('div', { class: 'kpi-label' }, el('i'), t('model.speed')), el('div', { class: 'kpi-value', text: times ? t('model.times', { n: num(times, 0) }) : '—' }), el('div', { class: 'kpi-sub', text: ai.model }))));

  // скорость: логарифмическая шкала от 0.001 мс до 10 с
  const pos = (ms) => `${Math.max(2, Math.min(100, ((Math.log10(ms) + 3) / 7) * 100))}%`;
  const speed = el('section', { class: 'panel c5' },
    el('div', { class: 'panel-head' }, el('h3', { text: t('model.speed_title') })),
    physMs ? el('div', { class: 'speed-row' }, el('span', { text: t('model.physics') }), el('div', { class: 'speed-track' }, el('i', { style: `width:${pos(physMs)};background:var(--water-fill)` })), el('b', { text: `${num(physMs / 1000, 2)} ${t('u.s')}` })) : null,
    onnxMs ? el('div', { class: 'speed-row' }, el('span', { text: t('model.onnx') }), el('div', { class: 'speed-track' }, el('i', { style: `width:${pos(onnxMs)};background:var(--leaf-fill)` })), el('b', { text: `${num(onnxMs, 3)} ${t('u.ms')}` })) : null,
    el('p', { class: 'note', text: t('model.speed_note') }));

  const crops = (ai.files && ai.files.crops) || {};
  const per = m.per_crop_test || {};
  const table = el('section', { class: 'panel c7' },
    el('div', { class: 'panel-head' }, el('h3', { text: t('model.crops_title') })),
    el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {}, el('th', { text: t('model.col_crop') }), el('th', { text: 'R²' }), el('th', { text: `RMSE, ${t('u.tha')}` }), el('th', { text: `MAE, ${t('u.tha')}` }))),
      el('tbody', {}, Object.entries(per).map(([c, v]) => el('tr', {},
        el('td', {}, el('b', { text: c }), crops[c] ? el('span', { class: 'panel-sub', text: `  ${crops[c]}` }) : null),
        el('td', { text: num(v.r2, 4) }), el('td', { text: num(v.rmse_t_ha) }), el('td', { text: num(v.mae_t_ha) }))))));

  const imp = Object.entries(ai.feature_importance || {}).sort((a, b) => b[1] - a[1]).filter(([, v], i) => i < 4 || v >= 0.005).slice(0, 8);
  const top = imp.length ? imp[0][1] : 1;
  const importance = el('section', { class: 'panel c7' },
    el('div', { class: 'panel-head' }, el('h3', { text: t('model.imp_title') })),
    imp.map(([n, v]) => el('div', { class: 'imp-row' }, el('span', { text: featLabel(n), title: featLabel(n) }),
      el('div', { class: 'imp-track' }, el('i', { style: `width:${(v / top) * 100}%` })), el('b', { text: `${num(v * 100, 0)}%` }))));

  const f = ai.files || {};
  const chips = [f.cli, f.man, f.gwt, ...Object.values(f.crops || {}), ...Object.values(f.soils || {})].filter(Boolean).map((x) => el('span', { class: 'chip', text: baseName(x) }));
  const rules = el('section', { class: 'panel c5' },
    el('div', { class: 'panel-head' }, el('h3', { text: t('model.files_title') })),
    el('div', { class: 'chips' }, chips),
    ai.trained_at ? el('p', { class: 'note', text: t('model.trained', { d: fmtDate(ai.trained_at.slice(0, 10), { day: 'numeric', month: 'long', year: 'numeric' }) }) }) : null,
    el('h3', { style: 'margin:20px 0 10px', text: t('model.rules_title') }),
    el('ul', { class: 'bullets' }, el('li', { text: t('model.rule1') }), el('li', { text: t('model.rule2', { y }) }), el('li', { text: t('model.rule3') })));

  const limits = el('section', { class: 'panel c12' },
    el('div', { class: 'panel-head' }, el('h3', { text: t('limits.title') })),
    el('ul', { class: 'bullets' }, el('li', { text: t('limits.text') }), el('li', { text: t('model.limit2') }), el('li', { text: t('model.limit3') })),
    el('p', { class: 'note' }, t('model.retrain').split(':')[0] + ': ', el('code', { text: 'python generate_model.py' })));

  root.append(el('div', { class: 'grid' }, speed, table, importance, rules, limits));
  return root;
}

/* ================= Настройки ================= */
function settings(ctx) {
  const s = ctx.state;
  const root = el('div', {});
  root.append(head(t('nav.settings'), t('set.lead')));
  const themeSeg = el('div', { class: 'seg wide', role: 'group', 'aria-label': t('set.theme') },
    [['light', 'set.light', 'sun'], ['dark', 'set.dark', 'moon'], ['system', 'set.system', 'sliders']].map(([v, k, ic]) =>
      el('button', { type: 'button', 'aria-pressed': String(s.themePref === v), on: { click: (e) => ctx.setTheme(v, e.currentTarget) } }, t(k))));
  const langSeg = el('div', { class: 'seg wide', role: 'group', 'aria-label': t('set.lang') },
    LANGS.map((l) => el('button', { type: 'button', lang: l.code, 'aria-pressed': String(l.code === getLang()), text: l.name, on: { click: () => ctx.changeLang(l.code) } })));
  const c = s.config;
  root.append(el('div', { class: 'grid' },
    el('section', { class: 'panel c7' },
      el('div', { class: 'set-row' }, el('div', {}, el('b', { text: t('set.theme') })), themeSeg),
      el('div', { class: 'set-row' }, el('div', {}, el('b', { text: t('set.lang') })), langSeg)),
    el('section', { class: 'panel c5' },
      el('div', { class: 'panel-head' }, el('h3', {}, t('set.account'), el('span', { class: 'soon', text: t('set.soon') }))),
      el('p', { class: 'panel-sub', text: t('set.account_text') }),
      el('div', { style: 'margin-top:16px' }, el('button', { type: 'button', class: 'btn', disabled: true }, icon('lock'), t('set.signin')))),
    el('section', { class: 'panel c12' },
      el('div', { class: 'panel-head' }, el('h3', { text: t('set.about') })),
      el('dl', { class: 'dl' },
        el('dt', { text: t('set.engine') }), el('dd', { text: (s.result && s.result.environment.engine) || 'AquaCrop-OSPy 3.1' }),
        el('dt', { text: t('set.region') }), el('dd', { text: (c && c.region) || '—' }),
        el('dt', { text: t('set.year') }), el('dd', { text: String((c && c.target_year) || 2024) }),
        el('dt', { text: t('set.version') }), el('dd', { text: 'KUCrop 3.0 (SaaS)' })))));
  return root;
}

export const PAGES = { overview, simulate, files, model, settings };
