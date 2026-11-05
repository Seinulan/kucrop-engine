'use strict';
/**
 * Блок «ИИ-суррогат»: знает ли модель выбранные файлы, и переобучение на выбранных файлах из интерфейса.
 * Использует глобальные из index.html: el, $, CONFIG, selected, entry, entries, loadConfig, renderSlot, fileMsg.
 */
const aiState = { poll: null, status: null };

function aiUnknownFiles() {
  if (!CONFIG) return [];
  const labels = { cli: 'Климат', crop: 'Культура', soil: 'Почва', man: 'Управление' };
  const out = [];
  for (const k of ['cli', 'crop', 'soil', 'man']) {
    const id = selected[k];
    if (!id) continue;
    if (k === 'soil' && CONFIG.builtin_soils[id]) {
      if (!(CONFIG.ai_builtin_soils || []).includes(id)) out.push(`${labels[k]}: ${id.replace('aquacrop:', '')}`);
      continue;
    }
    const e = entry(k, id);
    if (e && !e.ai_trained) out.push(`${labels[k]}: ${e.name}`);
  }
  return out;
}

function aiAdvice() {
  const u = aiUnknownFiles();
  return u.length ? 'ИИ не знает изменённые файлы, поэтому покажет только физику. Можно переобучить ИИ (блок «ИИ-суррогат» ниже).' : '';
}

function renderAiCard() {
  const box = $('aiCard');
  if (!box || !CONFIG) return;
  const ai = CONFIG.ai || {};
  const unknown = aiUnknownFiles();
  const st = aiState.status;
  const running = st && st.state === 'running';
  const head = el('div', { className: 'flex flex-wrap items-center gap-2' },
    el('span', { className: 'lbl', style: 'margin:0', textContent: '🤖 ИИ-суррогат' }),
    el('span', { className: `badge ${unknown.length || !ai.available ? 'ai-no' : 'ai-ok'}`,
                 textContent: !ai.available ? 'не загружен' : unknown.length ? 'не знает выбранные файлы' : 'знает выбранные файлы' }));
  const lines = [];
  if (ai.available) {
    const m = ai.metrics || {};
    const f = ai.files || {};
    const names = (o) => Object.values(o || {}).map((x) => String(x).replace('aquacrop:', '').split('/').pop()).join(', ');
    lines.push(`Обучен на ${ai.n_samples} расчётах (${ai.target_year}): культуры ${names(f.crops)}; почвы ${names(f.soils)}. R² = ${m.r2_test}, RMSE = ${m.rmse_test_t_ha} т/га.`);
  } else {
    lines.push(ai.reason || 'Модель не загружена.');
  }
  if (unknown.length) lines.push(`Не участвовали в обучении: ${unknown.join('; ')}. Для них сайт показывает только физику AquaCrop.`);
  const btn = el('button', { type: 'button', className: unknown.length ? 'btn primary' : 'btn', disabled: running, textContent: running ? 'Обучение идёт…' : 'Переобучить ИИ на выбранных файлах…' });
  btn.addEventListener('click', openTrainDialog);
  box.replaceChildren(head, ...lines.map((t) => el('p', { className: 'text-xs text-slate-400 mt-1.5', textContent: t })));
  if (running || (st && (st.state === 'done' || st.state === 'error'))) box.append(aiProgress(st));
  box.append(el('div', { className: 'mt-2' }, btn));
}

function aiProgress(st) {
  const wrap = el('div', { className: 'mt-2' });
  if (st.state === 'running') {
    wrap.append(el('div', { className: 'bar' }, el('i', { style: `width:${Math.round((st.progress || 0) * 100)}%` })),
      el('p', { className: 'text-xs text-slate-400 mt-1', textContent: `${st.stage || 'Запуск'} · ${st.elapsed_s || 0} с` }));
  } else if (st.state === 'done') {
    const m = st.metrics || {};
    wrap.append(el('p', { className: 'text-xs text-emerald-300 mt-1', textContent: `✓ ИИ переобучен за ${st.elapsed_s} с на ${st.n_samples} расчётах: R² = ${m.r2_test}, RMSE = ${m.rmse_test_t_ha} т/га.` }));
  } else if (st.state === 'error') {
    wrap.append(el('p', { className: 'text-xs text-red-300 mt-1', textContent: `✗ Обучение не удалось: ${st.error}` }));
  }
  return wrap;
}

/* ---------- окно переобучения ---------- */
function openTrainDialog() {
  if (!CONFIG) return;
  let ov = $('trOverlay');
  if (ov) ov.remove();
  ov = el('div', { id: 'trOverlay', className: 'ov', role: 'dialog', ariaModal: 'true', ariaLabel: 'Переобучение ИИ' });
  const gwt = entry('gwt', selected.gwt), gwtOk = gwt && gwt.summary && gwt.summary.mode === 1;
  const cliHas = entry('cli', selected.cli) && entry('cli', selected.cli).summary && entry('cli', selected.cli).summary.has_target_year;
  const speed = (CONFIG.ai && CONFIG.ai.speed && CONFIG.ai.speed.physics_s_per_run) || 0.25;

  const pickList = (kind, builtin) => {
    const files = entries(kind).filter((e) => e.ok);
    const rows = files.map((e) => ({ id: e.id, text: e.name + (e.source === 'user' ? ' · свой' : ''), on: e.id === selected[kind] || e.ai_trained }));
    if (builtin) Object.entries(CONFIG.builtin_soils).forEach(([id, t]) => rows.push({ id, text: t, on: id === selected[kind] || (CONFIG.ai_builtin_soils || []).includes(id) }));
    return rows.map((r) => el('label', { className: 'pick' }, el('input', { type: 'checkbox', value: r.id, checked: r.on }), r.text));
  };
  const crops = pickList('crop'), soils = pickList('soil', true);
  const nSel = el('select', { className: 'ed-in', style: 'width:auto' },
    ...[[400, 'быстро (400 расчётов)'], [1000, 'обычно (1000)'], [1800, 'точно (1800)']].map(([v, t]) => el('option', { value: v, textContent: t, selected: v === 1000 })));
  const est = el('span', { className: 'text-xs text-slate-400' });
  const err = el('p', { className: 'text-xs text-red-300 mt-2', textContent: '' });
  const checked = (list) => list.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
  const refresh = () => {
    const nc = checked(crops).length, ns = checked(soils).length, n = Number(nSel.value);
    est.textContent = `Комбинаций: ${nc * ns * 4}. Займёт примерно ${Math.max(1, Math.round((n * speed + 40) / 60))} мин.`;
  };
  [...crops, ...soils].forEach((l) => l.querySelector('input').addEventListener('change', refresh));
  nSel.addEventListener('change', refresh);

  const start = el('button', { type: 'button', className: 'btn primary', textContent: 'Начать обучение' });
  const cancel = el('button', { type: 'button', className: 'btn', textContent: 'Отмена' });
  cancel.addEventListener('click', () => ov.remove());
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.remove(); });
  start.addEventListener('click', async () => {
    const body = { cli: selected.cli, man: selected.man, gwt: selected.gwt, crops: checked(crops), soils: checked(soils), n: Number(nSel.value) };
    if (!body.crops.length || !body.soils.length) return (err.textContent = 'Отметьте хотя бы одну культуру и одну почву');
    if (!gwtOk) return (err.textContent = 'Выбранный .GWT должен быть с постоянным уровнем грунтовых вод');
    if (!cliHas) return (err.textContent = `В выбранном климате нет ${CONFIG.target_year} года`);
    start.disabled = true;
    const r = await fetch('/api/train', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.success) { start.disabled = false; return (err.textContent = d.error || `HTTP ${r.status}`); }
    ov.remove();
    aiStartPolling();
  });

  const fixed = (label, id) => el('li', { textContent: `${label}: ${id ? id.split('/').pop() : '—'}` });
  ov.append(el('div', { className: 'dlg narrow' },
    el('div', { className: 'dlg-head' }, el('h3', { textContent: 'Переобучить ИИ на выбранных файлах' })),
    el('div', { className: 'dlg-body' },
      el('p', { className: 'text-xs text-slate-400 mb-3', textContent: 'ИИ заново учится повторять расчёт AquaCrop на выбранных файлах (целевой год ' + CONFIG.target_year + '). Расчёты идут на сервере в фоне — страницей можно пользоваться.' }),
      el('h4', { className: 'lbl', textContent: 'Культуры' }), el('div', { className: 'mb-3' }, ...crops),
      el('h4', { className: 'lbl', textContent: 'Почвы' }), el('div', { className: 'mb-3' }, ...soils),
      el('h4', { className: 'lbl', textContent: 'Берутся из выбранных на странице' }),
      el('ul', { className: 'text-xs text-slate-300 list-disc pl-5 mb-3' }, fixed('Климат', selected.cli), fixed('Управление', selected.man), fixed('Грунтовые воды', selected.gwt)),
      el('div', { className: 'flex items-center gap-3' }, el('span', { className: 'lbl', style: 'margin:0', textContent: 'Точность' }), nSel), est, err),
    el('div', { className: 'dlg-foot' }, el('span', { style: 'margin-right:auto' }), cancel, start)));
  document.body.append(ov);
  refresh();
}

/* ---------- ход обучения ---------- */
async function aiPoll() {
  try {
    const r = await fetch('/api/train/status');
    const st = await r.json();
    const was = aiState.status && aiState.status.state;
    aiState.status = st;
    if (st.state !== 'running') {
      clearInterval(aiState.poll); aiState.poll = null;
      if (was === 'running' && st.state === 'done') {
        try { await loadConfig(); } catch (e) { /* список обновится при следующей загрузке */ }
        fileMsg(`ИИ переобучен: R² = ${(st.metrics || {}).r2_test}, RMSE = ${(st.metrics || {}).rmse_test_t_ha} т/га. Теперь он знает выбранные файлы.`, true);
      }
    }
    renderAiCard();
  } catch (e) { /* сервер недоступен — попробуем на следующем шаге */ }
}

function aiStartPolling() {
  aiState.status = { state: 'running', progress: 0, stage: 'Запуск', elapsed_s: 0 };
  renderAiCard();
  if (!aiState.poll) aiState.poll = setInterval(aiPoll, 1500);
}

// после загрузки страницы: показать карточку и подхватить уже идущее обучение
(async () => {
  for (let i = 0; i < 100 && !CONFIG; i++) await new Promise((r) => setTimeout(r, 100));
  renderAiCard();
  try {
    const st = await (await fetch('/api/train/status')).json();
    if (st.state === 'running') aiStartPolling();
  } catch (e) { /* без обучения */ }
})();
