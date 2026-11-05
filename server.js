'use strict';
/**
 * KUCrop - бэкенд (Node.js + Express).
 *   POST /api/predict  - физический расчёт AquaCrop (Python) и ИИ-прогноз (ONNX) параллельно
 *   GET  /api/config   - справочники и значения по умолчанию из файлов AquaCrop, метрики ИИ
 *
 * Признаки ИИ и их порядок берутся из model_meta.json (пишет generate_model.py),
 * поэтому после переобучения server.js менять не нужно.
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const PYTHON = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const MAX_PARALLEL = Math.max(1, Number(process.env.MAX_PARALLEL || 2));
const PY_TIMEOUT_MS = Number(process.env.PY_TIMEOUT_MS || 120000);
const MARK_RE = /---JSON_OUTPUT_START---\s*([\s\S]*?)\s*---JSON_OUTPUT_END---/;
const PARAM_KEYS = ['crop', 'irrigation', 'startDate', 'soil', 'gwDepth', 'initWater'];
const SOIL_ALIASES = { ClayLoam: 'Poltavka_NKA' };

/* ---------- запуск Python с ограничением параллелизма ---------- */
let active = 0;
const queue = [];
const acquire = () => (active < MAX_PARALLEL ? (active++, Promise.resolve()) : new Promise((r) => queue.push(r)));
const release = () => { const next = queue.shift(); if (next) next(); else active--; };

function runPython(args) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [path.join(ROOT, 'run_aquacrop.py'), ...args], { cwd: ROOT, windowsHide: true });
    let out = '', err = '', done = false;
    const finish = (res) => { if (!done) { done = true; clearTimeout(timer); resolve(res); } };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: `Расчёт превысил лимит времени (${PY_TIMEOUT_MS / 1000} с)` });
    }, PY_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: `Не удалось запустить Python (${PYTHON}): ${e.message}. Задайте PYTHON_BIN.` }));
    child.on('close', () => {
      const m = out.match(MARK_RE);
      if (!m) return finish({ ok: false, error: 'Python не вернул результат', detail: (err || out).slice(-800) });
      try {
        const data = JSON.parse(m[1]);
        finish(data.success === false ? { ok: false, error: data.error || 'Ошибка расчёта', userError: true } : { ok: true, data });
      } catch (e) {
        finish({ ok: false, error: 'Python вернул некорректный JSON', detail: e.message });
      }
    });
  });
}

async function runPythonQueued(args) {
  await acquire();
  try { return await runPython(args); } finally { release(); }
}

/* ---------- справочники (кешируются: файлы AquaCrop не меняются во время работы) ---------- */
let configCache = null;
async function getConfig() {
  if (configCache) return configCache;
  const py = await runPythonQueued(['--config']);
  if (!py.ok) throw new Error(py.error + (py.detail ? `: ${py.detail}` : ''));
  configCache = py.data;
  return configCache;
}

/* ---------- ИИ-модель (ONNX) ---------- */
let ort = null, session = null, meta = null, aiLoadError = null;

async function loadModel() {
  try {
    meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'model_meta.json'), 'utf8'));
    ort = require('onnxruntime-node');
    session = await ort.InferenceSession.create(path.join(ROOT, 'aquacrop_model.onnx'));
    const m = meta.metrics || {};
    console.log(`ИИ-модель: ${meta.model || '?'}, ${meta.feature_names.length} признаков, R2(test)=${m.r2_test}, RMSE=${m.rmse_test_t_ha} т/га`);
  } catch (e) {
    session = null;
    aiLoadError = e.code === 'ENOENT'
      ? 'Нет aquacrop_model.onnx / model_meta.json - запустите python generate_model.py'
      : `Не удалось загрузить ИИ-модель: ${e.message}`;
    console.warn('ВНИМАНИЕ:', aiLoadError);
  }
}

function parseDate(s) {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(String(s));
  if (!m) throw new Error('Неверная дата посева');
  const year = +m[1];
  const doy = Math.round((Date.UTC(year, +m[2] - 1, +m[3]) - Date.UTC(year, 0, 0)) / 86400000);
  return { year, doy };
}

function buildFeatures(p) {
  const { year, doy } = parseDate(p.startDate);
  const f = {
    gw_depth: Number(p.gwDepth),
    init_fc: p.initWater === 'FC' ? 1 : 0,
    irrigated: p.irrigation === 'Irrigated' ? 1 : 0,
    planting_doy: doy,
  };
  for (const y of meta.categories.year || []) f['year_' + y] = year === y ? 1 : 0;
  for (const c of meta.categories.crop) f['crop_' + c] = p.crop === c ? 1 : 0;
  for (const s of meta.categories.soil) f['soil_' + s] = p.soil === s ? 1 : 0;
  return meta.feature_names.map((n) => {
    if (!Number.isFinite(f[n])) throw new Error(`Нет значения признака '${n}'`);
    return f[n];
  });
}

function domainNotes(p) {
  const r = meta.ranges || {};
  const notes = [];
  const gw = Number(p.gwDepth);
  const { year, doy } = parseDate(p.startDate);
  if (r.gw_depth && (gw < r.gw_depth[0] || gw > r.gw_depth[1])) notes.push(`глубина грунтовых вод вне диапазона обучения (${r.gw_depth[0]}-${r.gw_depth[1]} м)`);
  if (r.planting_doy && (doy < r.planting_doy[0] || doy > r.planting_doy[1])) notes.push('дата посева вне окна обучения');
  if (r.years && !r.years.includes(year)) notes.push(`год ${year} не участвовал в обучении`);
  if (!meta.categories.crop.includes(p.crop)) notes.push('культура не участвовала в обучении');
  if (!meta.categories.soil.includes(p.soil)) notes.push('почва не участвовала в обучении');
  return notes;
}

async function predictAI(p) {
  if (!session) throw new Error(aiLoadError || 'ИИ-модель не загружена');
  const feats = buildFeatures(p);
  const input = new ort.Tensor('float32', Float32Array.from(feats), [1, feats.length]);
  const out = await session.run({ [meta.input_name || session.inputNames[0]]: input });
  const v = Number(out[session.outputNames[0]].data[0]);
  if (!Number.isFinite(v)) throw new Error('ИИ вернул нечисловой результат');
  const notes = domainNotes(p);
  return { value: Math.round(Math.max(0, v) * 100) / 100, inDomain: notes.length === 0, note: notes.join('; ') };
}

/* ---------- HTTP ---------- */
const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/config', async (req, res) => {
  try {
    const cfg = { ...(await getConfig()) };
    cfg.ai = session
      ? { available: true, model: meta.model, metrics: meta.metrics, n_samples: meta.n_samples, ranges: meta.ranges, trained_at: meta.trained_at }
      : { available: false, reason: aiLoadError };
    res.json(cfg);
  } catch (e) {
    res.status(503).json({ success: false, error: e.message });
  }
});

app.post('/api/predict', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const params = {};
  for (const k of PARAM_KEYS) if (body[k] !== undefined && body[k] !== '') params[k] = String(body[k]).slice(0, 40);
  if (params.soil) params.soil = SOIL_ALIASES[params.soil] || params.soil;

  let cfg = null;
  try { cfg = await getConfig(); } catch (e) { /* физика сама сообщит об ошибке */ }
  const aiParams = {
    crop: params.crop || 'Sunflower',
    irrigation: params.irrigation || 'Rainfed',
    startDate: params.startDate || (cfg ? cfg.planting.default : ''),
    soil: params.soil || (cfg ? cfg.default_soil : 'Poltavka_NKA'),
    gwDepth: params.gwDepth || (cfg ? String(cfg.groundwater.default) : ''),
    initWater: params.initWater || 'FC',
  };

  const [phys, ai] = await Promise.allSettled([runPythonQueued([JSON.stringify(params)]), predictAI(aiParams)]);
  const py = phys.status === 'fulfilled' ? phys.value : { ok: false, error: String(phys.reason) };
  if (!py.ok) {
    if (py.detail) console.error('Ошибка расчёта:', py.detail);
    return res.status(py.userError ? 400 : 500).json({ success: false, error: py.error });
  }

  const result = { ...py.data };
  if (ai.status === 'fulfilled') {
    result.ai_yield = ai.value.value;
    result.ai_in_domain = ai.value.inDomain;
    result.ai_note = ai.value.note || null;
    result.ai_metrics = meta.metrics || null;
  } else {
    result.ai_yield = null;
    result.ai_error = ai.reason && ai.reason.message ? ai.reason.message : String(ai.reason);
  }
  res.json(result);
});

if (require.main === module) {
  loadModel().then(() => app.listen(PORT, () => console.log(`KUCrop: http://localhost:${PORT}  (python: ${PYTHON})`)));
}

module.exports = { buildFeatures, parseDate, domainNotes, _setMeta: (m) => { meta = m; } };
