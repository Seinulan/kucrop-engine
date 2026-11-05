'use strict';
/**
 * Редактор файлов AquaCrop в браузере: формы с понятными подписями + «сырой» текст,
 * проверка на сервере на лету, подсветка изменений, сохранение копии, скачивание.
 *
 * Использует глобальные из index.html: el, $, CONFIG, SLOTS, selected, entry, loadConfig, renderSlot, onFilesChanged, fileMsg.
 * Встроенные файлы не перезаписываются: правка встроенного файла сохраняется как копия в user_files/.
 */

/* ---------- русские подписи для основных строк (номер строки в файле, 1 = заголовок) ---------- */
const ED_CRO = [
  ['Фенология (календарные дни от посева)', [
    [52, 'Всходы', 'дн.'], [53, 'Макс. глубина корней', 'дн.'], [54, 'Начало старения', 'дн.'], [55, 'Созревание (длина цикла)', 'дн.'],
    [56, 'Цветение', 'дн.'], [57, 'Длительность цветения', 'дн.'], [60, 'Формирование урожая', 'дн.']]],
  ['Температуры', [
    [8, 'Tbase: ниже развитие стоит', '°C'], [9, 'Tupp: выше развитие не растёт', '°C'],
    [27, 'Холод: опыление нарушается ниже', '°C'], [28, 'Жара: опыление нарушается выше', '°C']]],
  ['Крона', [
    [46, 'CGC: рост кроны', 'доля/сут'], [50, 'CCx: макс. покрытие кроны', 'доля'], [51, 'CDC: спад кроны', 'доля/сут'],
    [45, 'Растений на гектар', 'шт/га'], [43, 'Площадь проростка', 'см²']]],
  ['Корни', [
    [37, 'Мин. глубина корней', 'м'], [38, 'Макс. глубина корней', 'м'], [39, 'Форма расширения корней', ''],
    [40, 'Макс. отбор воды, верх зоны', 'м³/м³·сут'], [41, 'Макс. отбор воды, низ зоны', 'м³/м³·сут']]],
  ['Водный стресс (доля истощения влаги)', [
    [11, 'p-exp верхний порог', '0–1'], [12, 'p-exp нижний порог', '0–1'], [13, 'p-exp форма', ''],
    [14, 'p-sto верхний порог', '0–1'], [16, 'p-sen верхний порог', '0–1'], [19, 'p-pol верхний порог', '0–1']]],
  ['Продуктивность', [
    [61, 'WP*: водная продуктивность', 'г/м²'], [64, 'HI0: индекс урожая', '%'], [35, 'Kcb (KcTr,x)', ''],
    [36, 'Старение Kc', '%/сут'], [63, 'Реакция на CO₂', '%'], [68, 'Макс. рост HI при стрессе', '%']]],
];
const ED_CRO_GDD = [[69, 'Всходы', 'GDD'], [70, 'Макс. глубина корней', 'GDD'], [71, 'Начало старения', 'GDD'], [72, 'Созревание', 'GDD'],
                    [73, 'Цветение', 'GDD'], [74, 'Длительность цветения', 'GDD'], [75, 'CGC в GDD', ''], [76, 'CDC в GDD', ''], [77, 'Формирование урожая', 'GDD']];
const ED_MAN = [[3, 'Покрытие поверхности мульчой', '%'], [4, 'Снижение испарения мульчой', '%'], [5, 'Стресс плодородия (движок не моделирует)', '%'],
                [6, 'Высота валиков', 'м'], [9, 'Сорняки при смыкании кроны (не моделируется)', '%'], [10, 'Прирост сорняков в середине сезона', '+%']];
const ED_GWT_LABEL = { 0: 'no groundwater table', 1: 'groundwater table at fixed depth and with constant salinity', 2: 'groundwater table with variable depth and salinity' };
const ED_SOL_COLS = [['Слой, м', 8], ['SAT, %', 8], ['FC, %', 6], ['WP, %', 6], ['Ksat, мм/сут', 9], ['Проницаемость, %', 10], ['Гравий, %', 8], ['CRa', 13], ['CRb', 10]];

const KV = /^(\s*)(\S+)(\s*):(.*)$/;
const NUM = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const ed = { slot: null, id: null, kind: null, name: '', orig: '', text: '', tab: 'form', builtin: false, seq: 0, timer: null,
             status: { state: 'idle' }, related: [], saving: false };

/* ---------- работа со строками ---------- */
const edLines = () => ed.text.split('\n');
const edOrigLines = () => ed.orig.split('\n');
const edSetLines = (L) => { ed.text = L.join('\n'); };
const edVal = (L, i) => { const m = KV.exec(L[i] || ''); return m ? m[2] : null; };
const edRest = (L, i) => { const m = KV.exec(L[i] || ''); return m ? m[4].trim() : ''; };
function edPut(L, i, v) {            // заменить число в строке «значение : описание», сохранив выравнивание двоеточия
  const m = KV.exec(L[i]);
  if (!m) return;
  const head = m[1] + m[2] + m[3];
  let nh = m[1] + v;
  nh = nh.length < head.length ? nh.padEnd(head.length) : nh + ' ';
  L[i] = nh + ':' + m[4];
}
const edDirty = () => ed.text !== ed.orig;
const edFindLine = (L, kw) => L.findIndex((l) => KV.test(l) && l.split(':').slice(1).join(':').toLowerCase().includes(kw));
const edSepIndex = (L) => L.findIndex((l) => l.trim().startsWith('='));

/* ---------- окно ---------- */
function edBuildDialog() {
  if ($('edOverlay')) return;
  const ov = el('div', { id: 'edOverlay', className: 'ov', hidden: true, role: 'dialog', ariaModal: 'true', ariaLabel: 'Редактор файла AquaCrop' });
  ov.innerHTML = `
    <div class="dlg">
      <div class="dlg-head">
        <h3 id="edTitle">Редактор</h3>
        <select id="edRelated" class="ed-in" style="width:auto;max-width:14rem" hidden></select>
        <label class="text-xs text-slate-400" for="edName">Имя файла</label>
        <input id="edName" class="ed-in" style="width:15rem;max-width:100%" spellcheck="false" autocomplete="off">
        <button type="button" class="btn" id="edClose" aria-label="Закрыть">✕</button>
      </div>
      <div class="ed-tabs" role="tablist">
        <button type="button" class="ed-tab" data-tab="form" role="tab">Форма</button>
        <button type="button" class="ed-tab" data-tab="text" role="tab">Текст</button>
        <button type="button" class="ed-tab" data-tab="diff" role="tab">Изменения <span id="edDiffCount"></span></button>
      </div>
      <div class="dlg-body" id="edBody"></div>
      <div class="dlg-foot">
        <span id="edChip" class="ed-chip" role="status" style="margin-right:auto"></span>
        <button type="button" class="btn" id="edPaste" title="Заменить текст содержимым буфера обмена">📋 Вставить из буфера</button>
        <button type="button" class="btn" id="edDownload" title="Скачать файл с правками (кодировка и переводы строк как в AquaCrop)">⬇ Скачать</button>
        <button type="button" class="btn primary" id="edSave">Сохранить</button>
      </div>
    </div>`;
  document.body.append(ov);
  $('edClose').addEventListener('click', edClose);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) edClose(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ov.hidden) edClose(); });
  ov.querySelectorAll('.ed-tab').forEach((b) => b.addEventListener('click', () => edTab(b.dataset.tab)));
  $('edName').addEventListener('input', () => { ed.name = $('edName').value.trim(); edScheduleCheck(); });
  $('edSave').addEventListener('click', edSave);
  $('edDownload').addEventListener('click', edDownload);
  $('edPaste').addEventListener('click', edPaste);
  $('edRelated').addEventListener('change', () => edLoadRelated($('edRelated').value));
}

function edSuggestName(name, asNew, builtin) {
  if (!asNew && !builtin) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  const taken = new Set(Object.values(CONFIG.library).flat().filter((e) => e.source === 'user').map((e) => e.name.toLowerCase()));
  let cand = `${stem}_my${ext}`, k = 2;
  while (taken.has(cand.toLowerCase())) cand = `${stem}_my${k++}${ext}`;
  return cand;
}

async function edFetch(id) {
  const r = await fetch(`/api/files/content?id=${encodeURIComponent(id)}`);
  const d = await r.json();
  if (!r.ok || !d.success) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

async function openEditor(slot, asNew) {
  if (!CONFIG) return;
  const id = selected[slot];
  if (!id || (slot === 'soil' && CONFIG.builtin_soils[id])) {
    return fileMsg('Встроенный профиль почвы не является файлом. Выберите .SOL, чтобы править его (или создайте новый кнопкой «＋»).', false);
  }
  let d;
  try { d = await edFetch(id); } catch (e) { return fileMsg('Не удалось открыть файл: ' + e.message, false); }
  edBuildDialog();
  ed.slot = slot; ed.id = id; ed.asNew = asNew;
  ed.related = [];
  if (slot === 'cli') {         // .CLI + ссылки на ряды погоды
    const files = (entry('cli', id) || {}).summary?.files || {};
    ed.related.push({ id, name: d.name });
    for (const k of ['tnx', 'eto', 'plu']) {
      const nm = files[k] && files[k].toLowerCase();
      const hit = nm && entries(k).find((e) => e.name.toLowerCase() === nm && e.source === (id.startsWith('user_files/') ? 'user' : 'builtin'))
                  || nm && entries(k).find((e) => e.name.toLowerCase() === nm);
      if (hit) ed.related.push({ id: hit.id, name: hit.name });
    }
  }
  edApply(d, asNew);
  $('edOverlay').hidden = false;
  edRenderHead();
  edTab(ed.kind === 'tnx' || ed.kind === 'eto' || ed.kind === 'plu' || ed.kind === 'cli' ? 'text' : 'form');
  edRunCheck();
  $('edName').focus();
}

function edApply(d, asNew) {
  ed.id = d.id; ed.builtin = d.builtin; ed.orig = d.text; ed.text = d.text;
  ed.kind = (d.name.split('.').pop() || '').toLowerCase();
  ed.name = edSuggestName(d.name, asNew, d.builtin);
  ed.saved = false;
}

function edRenderHead() {
  const kindName = { cro: 'культура', sol: 'почва', gwt: 'грунтовые воды', man: 'управление полем', cli: 'климат', tnx: 'температура', eto: 'ETo', plu: 'осадки' };
  const ext = ed.kind === 'cro' ? 'crop' : ed.kind;
  ed.kind = ext;
  $('edTitle').textContent = `Редактор · ${kindName[(ed.id.split('.').pop() || '').toLowerCase()] || ed.kind}`;
  $('edName').value = ed.name;
  const rel = $('edRelated');
  rel.hidden = ed.related.length < 2;
  rel.replaceChildren(...ed.related.map((r) => el('option', { value: r.id, textContent: r.name, selected: r.id === ed.id })));
  $('edSave').textContent = ed.builtin || ed.name !== ed.id.split('/').pop() ? 'Сохранить копию' : 'Сохранить';
  const formOk = ['crop', 'sol', 'gwt', 'man'].includes(ed.kind);
  $('edOverlay').querySelector('[data-tab="form"]').disabled = !formOk;
}

async function edLoadRelated(id) {
  if (edDirty() && !confirm('Несохранённые правки будут потеряны. Перейти к другому файлу?')) { $('edRelated').value = ed.id; return; }
  try { edApply(await edFetch(id), false); } catch (e) { return edChip('err', e.message); }
  edRenderHead(); edTab('text'); edRunCheck();
}

function edClose() {
  if (edDirty() && !ed.saved && !confirm('Закрыть без сохранения? Правки будут потеряны.')) return;
  $('edOverlay').hidden = true;
}

function edTab(tab) {
  const formOk = ['crop', 'sol', 'gwt', 'man'].includes(ed.kind);
  ed.tab = tab === 'form' && !formOk ? 'text' : tab;
  $('edOverlay').querySelectorAll('.ed-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === ed.tab)));
  edRenderBody();
}

function edChip(state, text) {
  const c = $('edChip');
  c.className = `ed-chip ${state === 'ok' ? 'ok' : state === 'err' ? 'err' : state === 'warn' ? 'warn' : ''}`;
  c.textContent = text;
  $('edSave').disabled = state === 'err' || state === 'pend' || ed.saving;
}

function edUpdateDiffCount() {
  const a = edOrigLines(), b = edLines();
  let n = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  $('edDiffCount').textContent = n ? `(${n})` : '';
}

/* ---------- проверка на сервере ---------- */
function edScheduleCheck() {
  clearTimeout(ed.timer);
  edChip('pend', 'Проверка…');
  edUpdateDiffCount();
  $('edSave').textContent = ed.builtin || ed.name !== ed.id.split('/').pop() ? 'Сохранить копию' : 'Сохранить';
  ed.timer = setTimeout(edRunCheck, 450);
}

async function edRunCheck() {
  const seq = ++ed.seq;
  edUpdateDiffCount();
  edChip('pend', 'Проверка…');
  let d;
  try {
    const r = await fetch('/api/files/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: ed.name, content: ed.text }) });
    d = await r.json();
  } catch (e) {
    return seq === ed.seq && edChip('err', 'Нет связи с сервером');
  }
  if (seq !== ed.seq) return;
  if (!d.success) return edChip('err', '✗ ' + d.error);
  const text = (d.summary && d.summary.text) || 'файл корректен';
  edChip(d.complete === false ? 'warn' : 'ok', `${d.complete === false ? '⚠' : '✓'} ${text}`);
}

/* ---------- тело окна ---------- */
function edRenderBody() {
  const body = $('edBody');
  body.replaceChildren();
  if (ed.tab === 'text') {
    const ta = el('textarea', { className: 'ed-text', spellcheck: false, value: ed.text, wrap: 'off', ariaLabel: 'Текст файла' });
    ta.addEventListener('input', () => { ed.text = ta.value.replace(/\r\n?/g, '\n'); edScheduleCheck(); });
    body.append(ta);
    body.append(el('p', { className: 'ed-note', textContent: 'Файл AquaCrop пишется в Windows-кодировке, переводы строк CRLF — при сохранении и скачивании это делается автоматически. Только латиница и цифры.' }));
    return;
  }
  if (ed.tab === 'diff') {
    const rows = edDiffLines();
    body.append(rows.length ? el('div', { className: 'ed-diff' }, ...rows) : el('p', { className: 'ed-note', textContent: 'Изменений нет — файл совпадает с исходным.' }));
    return;
  }
  ({ crop: edFormCro, man: edFormMan, sol: edFormSol, gwt: edFormGwt })[ed.kind]?.(body);
}

function edDiffLines() {
  const a = edOrigLines(), b = edLines(), out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push(el('div', { className: 'del', textContent: `− ${i + 1}: ${a[i]}` }));
    if (b[i] !== undefined) out.push(el('div', { className: 'add', textContent: `+ ${i + 1}: ${b[i]}` }));
  }
  if (a.length !== b.length) out.push(el('div', { className: 'del', textContent: `Число строк: было ${a.length}, стало ${b.length}` }));
  return out;
}

/* ---------- поля ---------- */
function edField(i, label, unit, o = {}) {
  const L = edLines(), O = edOrigLines();
  const cur = edVal(L, i), orig = edVal(O, i);
  if (cur === null) return null;
  const wrap = el('label', { className: 'ed-f' });
  const reset = el('button', { type: 'button', className: 'ed-reset', title: 'Вернуть исходное значение', textContent: '↺', hidden: true });
  const inp = o.options
    ? el('select', { className: 'ed-in' }, ...o.options.map(([v, t]) => el('option', { value: v, textContent: t, selected: v === cur })))
    : el('input', { className: 'ed-in', value: cur, inputMode: 'decimal', autocomplete: 'off', spellcheck: false, title: edRest(L, i) });
  wrap.append(el('span', {}, el('b', { className: 'font-medium', textContent: label }), el('em', {}, unit || '', ' ', reset)), inp);
  const refresh = () => { const ch = inp.value.trim() !== orig; wrap.classList.toggle('chg', ch); reset.hidden = !ch; };
  const apply = () => {
    const v = inp.value.trim();
    const bad = !o.options && !NUM.test(v);
    wrap.classList.toggle('bad', bad);
    if (!bad) { const M = edLines(); edPut(M, i, v); edSetLines(M); edScheduleCheck(); }
    refresh();
  };
  inp.addEventListener('input', apply);
  inp.addEventListener('change', apply);
  reset.addEventListener('click', () => { inp.value = orig; apply(); });
  refresh();
  return wrap;
}

const edSection = (title, nodes, extra) => el('div', { className: 'ed-sec' }, el('h4', { textContent: title }), extra || '', el('div', { className: 'ed-grid' }, ...nodes.filter(Boolean)));

function edTitleField() {
  const L = edLines();
  const wrap = el('label', { className: 'ed-f', style: 'margin-bottom:.8rem' });
  const inp = el('input', { className: 'ed-in', value: (L[0] || '').trim(), spellcheck: false });
  inp.addEventListener('input', () => {
    if (/[^\x00-\xff]/.test(inp.value)) { wrap.classList.add('bad'); return; }
    wrap.classList.remove('bad');
    const M = edLines(); M[0] = inp.value; edSetLines(M); edScheduleCheck();
  });
  wrap.append(el('span', {}, el('b', { className: 'font-medium', textContent: 'Описание (первая строка файла)' })), inp);
  return wrap;
}

/* ---------- .CRO ---------- */
function edFormCro(body) {
  body.append(edTitleField());
  for (const [title, rows] of ED_CRO) {
    const nodes = rows.map(([n, label, unit]) => edField(n - 1, label, unit));
    if (title.startsWith('Фенология')) {
      nodes.unshift(edField(5, 'Тип цикла', '', { options: [['1', 'календарные дни'], ['2', 'градусо-дни (GDD)']] }));
    }
    body.append(edSection(title, nodes));
  }
  const gdd = edSection('Фенология в градусо-днях (используется, если тип цикла = GDD)', ED_CRO_GDD.map(([n, l, u]) => edField(n - 1, l, u)));
  body.append(gdd);
  // все строки файла: поиск по подписи
  const all = el('details', { className: 'ed-sec' });
  const search = el('input', { className: 'ed-in', placeholder: 'Поиск по описанию параметра…', style: 'margin:.5rem 0' });
  const grid = el('div', { className: 'ed-grid' });
  const L = edLines();
  const items = [];
  for (let i = 1; i < L.length; i++) {
    if (edVal(L, i) === null) continue;
    const f = edField(i, edRest(L, i).slice(0, 90), `стр. ${i + 1}`);
    if (f) { f.dataset.q = edRest(L, i).toLowerCase(); items.push(f); grid.append(f); }
  }
  search.addEventListener('input', () => { const q = search.value.toLowerCase(); items.forEach((f) => { f.hidden = !!q && !f.dataset.q.includes(q); }); });
  all.append(el('summary', { className: 'cursor-pointer text-slate-400', textContent: `Все параметры файла (${items.length}) — подписи как в AquaCrop` }), search, grid);
  body.append(all);
}

/* ---------- .MAN ---------- */
function edFormMan(body) {
  body.append(edTitleField());
  body.append(edSection('Управление полем', ED_MAN.map(([n, l, u]) => edField(n - 1, l, u))));
  body.append(el('p', { className: 'ed-note', textContent: 'Плодородие и сорняки сохраняются в файле, но движок AquaCrop-OSPy их не учитывает — на расчёт влияют только мульча и валики.' }));
  const all = el('details', { className: 'ed-sec' });
  const grid = el('div', { className: 'ed-grid' });
  const L = edLines();
  for (let i = 1; i < L.length; i++) { const f = edVal(L, i) !== null && edField(i, edRest(L, i).slice(0, 90), `стр. ${i + 1}`); if (f) grid.append(f); }
  all.append(el('summary', { className: 'cursor-pointer text-slate-400', textContent: 'Все параметры файла' }), grid);
  body.append(all);
}

/* ---------- таблицы (.SOL горизонты, .GWT наблюдения) ---------- */
function edTableRows(L, minNums, from = 0) {
  const rows = [];
  for (let i = from; i < L.length; i++) {
    const t = L[i].trim().split(/\s+/);
    if (t.length >= minNums && t.slice(0, minNums).every((x) => NUM.test(x))) rows.push(i);
  }
  return rows;
}

function edFormSol(body) {
  const L = edLines();
  const iCn = edFindLine(L, 'curve number'), iRew = edFindLine(L, 'readily evaporable');
  body.append(edSection('Почва в целом', [edField(iCn, 'CN — кривая стока', '0–100'), edField(iRew, 'REW — легко испаряемая вода', 'мм')]));
  const holder = el('div', { className: 'ed-sec' });
  body.append(holder);
  const render = () => {
    const M = edLines();
    const rows = edTableRows(M, 9);
    const O = new Set(edOrigLines());
    const tbl = el('table', { className: 'ed-table' });
    tbl.append(el('thead', {}, el('tr', {}, ...[...ED_SOL_COLS.map((c) => c[0]), 'Описание', ''].map((h) => el('th', { textContent: h })))));
    const tb = el('tbody');
    rows.forEach((li, ri) => {
      const t = M[li].trim().split(/\s+/);
      const cells = t.slice(0, 9);
      let desc = t.slice(9).join(' ');
      const tr = el('tr');
      const write = () => {
        const N = edLines();
        N[li] = cells.map((v, k) => v.padStart(ED_SOL_COLS[k][1])).join(' ') + '   ' + desc;
        edSetLines(N); edScheduleCheck();
      };
      cells.forEach((v, k) => {
        const inp = el('input', { className: 'ed-in', value: v, inputMode: 'decimal', style: `min-width:${k >= 7 ? '6.2rem' : '3.8rem'}` });
        inp.addEventListener('input', () => { const ok = NUM.test(inp.value.trim()); inp.style.borderColor = ok ? '' : '#f87171'; if (ok) { cells[k] = inp.value.trim(); write(); } });
        tr.append(el('td', {}, inp));
      });
      const di = el('input', { className: 'ed-in', value: desc, style: 'min-width:9rem', spellcheck: false });
      di.addEventListener('input', () => { if (!/[^\x00-\xff]/.test(di.value)) { desc = di.value; write(); } });
      tr.append(el('td', {}, di));
      const del = el('button', { type: 'button', className: 'btn', title: 'Удалить горизонт', textContent: '✕', disabled: rows.length < 2 });
      del.addEventListener('click', () => { const N = edLines(); N.splice(li, 1); edPut(N, edFindLine(N, 'number of soil horizons'), String(rows.length - 1)); edSetLines(N); edScheduleCheck(); render(); });
      tr.append(el('td', {}, del));
      tb.append(tr);
    });
    tbl.append(tb);
    const add = el('button', { type: 'button', className: 'btn', textContent: '＋ Добавить горизонт (копия последнего)' });
    add.addEventListener('click', () => {
      const N = edLines(); const last = rows[rows.length - 1];
      N.splice(last + 1, 0, N[last]);
      edPut(N, edFindLine(N, 'number of soil horizons'), String(rows.length + 1));
      edSetLines(N); edScheduleCheck(); render();
    });
    holder.replaceChildren(el('h4', { textContent: 'Горизонты (сверху вниз)' }), el('div', { className: 'ed-scroll' }, tbl), el('div', { style: 'margin-top:.6rem' }, add),
      el('p', { className: 'ed-note', textContent: 'Нужно WP < FC < SAT. CRa и CRb задают капиллярный подъём от грунтовых вод; число горизонтов в заголовке файла обновляется само.' }));
  };
  render();
}

/* ---------- .GWT ---------- */
function edFormGwt(body) {
  body.append(edTitleField());
  const L = edLines();
  const iMode = L.findIndex((l, i) => i > 0 && i < 6 && KV.test(l) && /groundwater/i.test(l));
  const origMode = Number(edVal(edOrigLines(), iMode));
  const opts = [['0', 'нет грунтовых вод'], ['1', 'постоянный уровень'], ...(origMode === 2 ? [['2', 'переменный уровень (по датам)']] : [])];
  const modeSel = edField(iMode, 'Режим', '', { options: opts });
  modeSel.querySelector('select').addEventListener('change', (e) => {
    const M = edLines(); const m = KV.exec(M[iMode]);
    M[iMode] = m[1] + m[2] + m[3] + ': ' + ED_GWT_LABEL[Number(e.target.value)]; edSetLines(M); edScheduleCheck(); edRenderBody();
  });
  const mode = Number(edVal(L, iMode));
  const nodes = [modeSel];
  for (const key of ['first day', 'first month', 'first year']) {
    const i = edFindLine(L, key);
    if (i >= 0 && mode === 2) nodes.push(edField(i, key.replace('first', 'Первый'), ''));
  }
  body.append(edSection('Грунтовые воды', nodes));
  if (mode === 0) return body.append(el('p', { className: 'ed-note', textContent: 'В этом режиме грунтовые воды в расчёте не участвуют.' }));
  const holder = el('div', { className: 'ed-sec' });
  body.append(holder);
  const render = () => {
    const M = edLines(); const sep = edSepIndex(M);
    const rows = sep < 0 ? [] : edTableRows(M, 3, sep + 1);
    const tbl = el('table', { className: 'ed-table' });
    tbl.append(el('thead', {}, el('tr', {}, ...['День', 'Глубина уровня, м', 'ECw, dS/м', ''].map((h) => el('th', { textContent: h })))));
    const tb = el('tbody');
    rows.forEach((li) => {
      const t = M[li].trim().split(/\s+/); const cells = t.slice(0, 3);
      const tr = el('tr');
      cells.forEach((v, k) => {
        const inp = el('input', { className: 'ed-in', value: v, inputMode: 'decimal' });
        inp.addEventListener('input', () => {
          const ok = NUM.test(inp.value.trim()); inp.style.borderColor = ok ? '' : '#f87171';
          if (ok) { cells[k] = inp.value.trim(); const N = edLines(); N[li] = `${cells[0].padStart(6)}  ${cells[1].padStart(8)}  ${cells[2].padStart(10)}`; edSetLines(N); edScheduleCheck(); }
        });
        tr.append(el('td', {}, inp));
      });
      const del = el('button', { type: 'button', className: 'btn', textContent: '✕', title: 'Удалить строку', disabled: mode === 1 || rows.length < 2 });
      del.addEventListener('click', () => { const N = edLines(); N.splice(li, 1); edSetLines(N); edScheduleCheck(); render(); });
      tr.append(el('td', {}, del));
      tb.append(tr);
    });
    tbl.append(tb);
    const kids = [el('h4', { textContent: mode === 1 ? 'Постоянный уровень' : 'Наблюдения за уровнем' }), el('div', { className: 'ed-scroll' }, tbl)];
    if (mode === 2) {
      const add = el('button', { type: 'button', className: 'btn', textContent: '＋ Добавить наблюдение' });
      add.addEventListener('click', () => { const N = edLines(); const last = rows[rows.length - 1]; const t = N[last].trim().split(/\s+/); t[0] = String(Number(t[0]) + 10); N.splice(last + 1, 0, `${t[0].padStart(6)}  ${t[1].padStart(8)}  ${t[2].padStart(10)}`); edSetLines(N); edScheduleCheck(); render(); });
      kids.push(el('div', { style: 'margin-top:.6rem' }, add));
    }
    kids.push(el('p', { className: 'ed-note', textContent: mode === 1 ? 'Глубина в строке данных — это то, что читает расчёт (число в заголовке файла — только комментарий). На сайте её можно ещё изменить отдельным полем.' : 'Дни считаются от первой даты записи; между наблюдениями уровень интерполируется.' }));
    holder.replaceChildren(...kids);
  };
  render();
}

/* ---------- кнопки: вставка, скачивание, сохранение ---------- */
async function edPaste() {
  let t = '';
  try { t = await navigator.clipboard.readText(); } catch (e) { /* нет доступа к буферу */ }
  if (!t) { edTab('text'); return edChip('warn', 'Буфер недоступен: вставьте текст сюда сочетанием Ctrl+V'); }
  if (edDirty() && !confirm('Заменить текущий текст содержимым буфера обмена?')) return;
  ed.text = t.replace(/\r\n?/g, '\n').replace(/\n+$/, '') + '\n';
  edTab('text'); edScheduleCheck();
}

function edBytes() {
  const t = ed.text.replace(/\n+$/, '') + '\n';
  const bad = [...t].find((ch) => ch.codePointAt(0) > 255);
  if (bad) throw new Error(`Символ «${bad}» нельзя записать в файл AquaCrop: используйте латиницу, цифры и знаки`);
  const crlf = t.replace(/\n/g, '\r\n');
  const out = new Uint8Array(crlf.length);
  for (let i = 0; i < crlf.length; i++) out[i] = crlf.charCodeAt(i);
  return out;
}

function edDownload() {
  let bytes;
  try { bytes = edBytes(); } catch (e) { return edChip('err', e.message); }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = el('a', { href: url, download: ed.name || 'file' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function edSave() {
  if (ed.saving) return;
  try { edBytes(); } catch (e) { return edChip('err', e.message); }
  ed.saving = true; $('edSave').disabled = true;
  try {
    const r = await fetch('/api/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: ed.name, content: ed.text }) });
    const d = await r.json();
    if (!r.ok || !d.success) { ed.saving = false; return edChip('err', '✗ ' + (d.error || `HTTP ${r.status}`)); }
    ed.saved = true; ed.saving = false;
    $('edOverlay').hidden = true;
    await loadConfig();
    const slot = ed.slot;
    if (d.kind === slot || (slot === 'cli' && d.kind === 'cli')) {
      selected[slot] = d.id; $(`sel_${slot}`).value = d.id; renderSlot(slot); onFilesChanged(slot);
    }
    fileMsg(`Сохранено: ${ed.name}${d.replaced ? ' (заменён)' : ''}. ` + (typeof aiAdvice === 'function' ? aiAdvice() : ''), true);
    if (typeof renderAiCard === 'function') renderAiCard();
  } catch (e) {
    ed.saving = false; edChip('err', 'Нет связи с сервером');
  }
}
