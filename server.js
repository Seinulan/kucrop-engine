'use strict';
/**
 * KUCrop - бэкенд (Node.js + Express).
 *   GET    /api/config              - библиотека файлов AquaCrop (+ сводки), значения по умолчанию, метрики ИИ
 *   POST   /api/predict             - физический расчёт AquaCrop по выбранным файлам + прогноз ИИ (ONNX)
 *   POST   /api/files               - загрузка файла (.CRO .SOL .GWT .MAN .CLI .Tnx .ETo .PLU) в user_files/
 *   DELETE /api/files?id=...        - удалить загруженный файл (встроенные файлы не удаляются)
 *   GET    /api/files/download?id=  - скачать файл
 *   GET    /api/files/content?id=   - текст файла для редактора
 *   POST   /api/files/check         - сухая проверка текста из редактора (ничего не сохраняется)
 *   POST   /api/train               - переобучить ИИ на выбранных файлах (фоновая задача)
 *   GET    /api/train/status        - ход обучения
 *
 * Признаки ИИ считает Python (kucrop_core.ai_block) - там же проверяется, что выбранные файлы
 * совпадают с файлами, на которых модель обучена. Node только выполняет ONNX.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const express = require('express');

const ROOT = __dirname;
const USER_DIR = path.join(ROOT, 'user_files');
const PORT = Number(process.env.PORT || 3000);
const PYTHON = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const MAX_PARALLEL = Math.max(1, Number(process.env.MAX_PARALLEL || 2));
const PY_TIMEOUT_MS = Number(process.env.PY_TIMEOUT_MS || 120000);
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const EXTENSIONS = ['.cro', '.sol', '.gwt', '.man', '.cli', '.tnx', '.eto', '.plu'];
const MARK_RE = /---JSON_OUTPUT_START---\s*([\s\S]*?)\s*---JSON_OUTPUT_END---/;
const PARAM_KEYS = ['cliFile', 'cropFile', 'soilFile', 'gwtFile', 'manFile', 'startDate', 'gwDepth', 'initWater', 'irrigation',
                    'crop', 'soil'];   // crop/soil - старый формат запроса

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

/* ---------- справочники (кеш сбрасывается при загрузке/удалении файлов) ---------- */
let configCache = null, configSig = '';

/* подпись набора файлов проекта: если файл положили/изменили/удалили в папке вручную, список обновится сам */
function filesSignature() {
  const parts = [];
  for (const dir of [ROOT, USER_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const n of fs.readdirSync(dir).sort()) {
      if (n.startsWith('.') || !EXTENSIONS.includes(path.extname(n).toLowerCase())) continue;
      try { const st = fs.statSync(path.join(dir, n)); parts.push(`${dir === ROOT ? '' : 'u/'}${n}:${st.size}:${st.mtimeMs}`); } catch (e) { /* файл исчез */ }
    }
  }
  for (const n of ['model_meta.json']) {
    try { parts.push(`${n}:${fs.statSync(path.join(ROOT, n)).mtimeMs}`); } catch (e) { /* нет модели */ }
  }
  return parts.join('|');
}

async function getConfig() {
  const sig = filesSignature();
  if (configCache && sig === configSig) return configCache;
  const py = await runPythonQueued(['--config']);
  if (!py.ok) throw new Error(py.error + (py.detail ? `: ${py.detail}` : ''));
  configCache = py.data;
  configSig = sig;
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
    console.log(`ИИ-модель: ${meta.model || '?'}, год ${meta.target_year}, ${meta.feature_names.length} признаков, R2=${m.r2_test}, RMSE=${m.rmse_test_t_ha} т/га`);
  } catch (e) {
    session = null;
    aiLoadError = e.code === 'ENOENT'
      ? 'Нет aquacrop_model.onnx / model_meta.json - запустите python generate_model.py'
      : `Не удалось загрузить ИИ-модель: ${e.message}`;
    console.warn('ВНИМАНИЕ:', aiLoadError);
  }
}

async function predictAI(features) {
  const input = new ort.Tensor('float32', Float32Array.from(features), [1, features.length]);
  const t = process.hrtime.bigint();
  const out = await session.run({ [meta.input_name || session.inputNames[0]]: input });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  const v = Number(out[session.outputNames[0]].data[0]);
  if (!Number.isFinite(v)) throw new Error('ИИ вернул нечисловой результат');
  return { value: Math.round(Math.max(0, v) * 100) / 100, ms };
}

/* ---------- файлы ---------- */
function safeName(name) {
  const base = path.basename(String(name || ''));
  const ext = path.extname(base).toLowerCase();
  if (!EXTENSIONS.includes(ext)) throw new Error(`Можно загружать только ${EXTENSIONS.join(' ').toUpperCase()}`);
  if (base.length > 80 || base.startsWith('.') || !/^[\p{L}\p{N} _.()-]+$/u.test(base)) {
    throw new Error('Имя файла: только буквы, цифры, пробел и символы _ . ( ) -, до 80 символов');
  }
  return base;
}

/* Файлы AquaCrop - Windows-кодировка (градусы в .CRO), строки CRLF. Текст из редактора кодируем так же. */
function textToBuffer(text) {
  const t = String(text || '').replace(/\r\n?/g, '\n').replace(/\n+$/, '') + '\n';
  for (const ch of t) {
    if (ch.codePointAt(0) > 255) throw new Error(`Символ «${ch}» нельзя записать в файл AquaCrop: используйте латиницу, цифры и знаки`);
  }
  return Buffer.from(t.replace(/\n/g, '\r\n'), 'latin1');
}

function fileById(id) {
  const s = String(id || '');
  if (s.startsWith('user_files/')) return path.join(USER_DIR, safeName(s.slice('user_files/'.length)));
  return path.join(ROOT, safeName(s));
}

/* ---------- HTTP ---------- */
const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/config', async (req, res) => {
  try {
    const cfg = { ...(await getConfig()) };
    cfg.ai = session
      ? { available: true, model: meta.model, target_year: meta.target_year, metrics: meta.metrics, speed: meta.speed,
          n_samples: meta.n_samples, ranges: meta.ranges, files: meta.training_file_names, trained_at: meta.trained_at }
      : { available: false, reason: aiLoadError };
    res.json(cfg);
  } catch (e) {
    res.status(503).json({ success: false, error: e.message });
  }
});

app.post('/api/files', async (req, res) => {
  let name;
  try {
    name = safeName(req.body && req.body.name);
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }
  let buf;
  try {
    buf = req.body && typeof req.body.content === 'string'
      ? textToBuffer(req.body.content)
      : Buffer.from(String((req.body && req.body.content_b64) || ''), 'base64');
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }
  if (!buf.length) return res.status(400).json({ success: false, error: 'Пустой файл' });
  if (buf.length > MAX_UPLOAD_BYTES) return res.status(400).json({ success: false, error: 'Файл больше 2 МБ' });

  fs.mkdirSync(USER_DIR, { recursive: true });
  const target = path.join(USER_DIR, name);
  const backup = fs.existsSync(target) ? fs.readFileSync(target) : null;
  fs.writeFileSync(target, buf);
  const py = await runPythonQueued(['--validate', target]);
  if (!py.ok) {                                   // файл не годится - вернуть как было
    if (backup) fs.writeFileSync(target, backup); else fs.rmSync(target, { force: true });
    return res.status(400).json({ success: false, error: py.error });
  }
  configCache = null;
  res.json({ success: true, replaced: Boolean(backup), ...py.data });
});

app.delete('/api/files', (req, res) => {
  const id = String(req.query.id || '');
  if (!id.startsWith('user_files/')) return res.status(400).json({ success: false, error: 'Удалять можно только загруженные файлы' });
  let p;
  try { p = fileById(id); } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
  if (!fs.existsSync(p)) return res.status(404).json({ success: false, error: 'Файл не найден' });
  fs.rmSync(p);
  configCache = null;
  res.json({ success: true });
});

app.get('/api/files/download', (req, res) => {
  let p;
  try { p = fileById(req.query.id); } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
  if (!fs.existsSync(p)) return res.status(404).json({ success: false, error: 'Файл не найден' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(p))}`);
  res.end(fs.readFileSync(p));
});

app.get('/api/files/content', (req, res) => {
  let p;
  try { p = fileById(req.query.id); } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
  if (!fs.existsSync(p)) return res.status(404).json({ success: false, error: 'Файл не найден' });
  const text = fs.readFileSync(p).toString('latin1').replace(/\r\n?/g, '\n');
  res.json({ success: true, id: String(req.query.id), name: path.basename(p), builtin: !String(req.query.id).startsWith('user_files/'), text });
});

app.post('/api/files/check', async (req, res) => {
  let name, buf;
  try {
    name = safeName(req.body && req.body.name);
    buf = textToBuffer(req.body && req.body.content);
  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
  if (buf.length > MAX_UPLOAD_BYTES) return res.json({ success: false, error: 'Файл больше 2 МБ' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kucrop-check-'));
  try {
    const target = path.join(dir, name);
    fs.writeFileSync(target, buf);
    const py = await runPythonQueued(['--check', target]);
    if (!py.ok) return res.json({ success: false, error: py.error });
    res.json({ success: true, ...py.data });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- переобучение ИИ на выбранных файлах ---------- */
let train = { state: 'idle' };

function trainSpecFrom(body) {
  const str = (v, what) => {
    if (typeof v !== 'string' || !v || v.length > 120) throw new Error(`Не указан файл: ${what}`);
    return v;
  };
  const list = (v, what) => {
    if (!Array.isArray(v) || !v.length || v.length > 8) throw new Error(`Выберите от 1 до 8 файлов: ${what}`);
    return v.map((x) => str(x, what));
  };
  return {
    cli: str(body.cli, 'климат'), man: str(body.man, 'управление'), gwt: str(body.gwt, 'грунтовые воды'),
    crops: list(body.crops, 'культуры'), soils: list(body.soils, 'почвы'),
  };
}

async function finishTraining(dir, code, log) {
  const files = ['aquacrop_model.onnx', 'model_meta.json', 'training_data.csv'];
  try {
    if (code !== 0 || files.some((f) => !fs.existsSync(path.join(dir, f)))) {
      const err = log.slice().reverse().find((l) => /ОШИБКА|Слишком много|Error|Traceback/i.test(l)) || log[log.length - 1] || 'неизвестная ошибка';
      train = { ...train, state: 'error', error: err.slice(0, 400), finished: Date.now() };
      return;
    }
    for (const f of files) {                      // сначала во временные имена, потом подмена
      fs.copyFileSync(path.join(dir, f), path.join(ROOT, `.new_${f}`));
    }
    for (const f of files) fs.renameSync(path.join(ROOT, `.new_${f}`), path.join(ROOT, f));
    aiLoadError = null;
    await loadModel();
    configCache = null;
    if (!session) {
      train = { ...train, state: 'error', error: aiLoadError || 'Новая модель не загрузилась', finished: Date.now() };
    } else {
      train = { ...train, state: 'done', progress: 1, metrics: meta.metrics, n_samples: meta.n_samples, finished: Date.now() };
    }
  } catch (e) {
    train = { ...train, state: 'error', error: e.message, finished: Date.now() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

app.post('/api/train', (req, res) => {
  if (train.state === 'running') return res.status(409).json({ success: false, error: 'Обучение уже идёт' });
  let spec;
  try { spec = trainSpecFrom(req.body || {}); } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
  const n = Math.min(3000, Math.max(100, Math.round(Number(req.body.n) || 1000)));
  const dir = fs.mkdtempSync(path.join(ROOT, '.train_'));
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec));
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  const child = spawn(PYTHON, ['generate_model.py', '--spec', path.join(dir, 'spec.json'), '--out-dir', dir, '--n', String(n)],
                      { cwd: ROOT, env, windowsHide: true });
  const log = [];
  train = { state: 'running', started: Date.now(), n, progress: 0, stage: 'Запуск', spec, pid: child.pid };
  let buf = '';
  const onLine = (line) => {
    if (!line.trim()) return;
    log.push(line);
    if (log.length > 60) log.shift();
    const m = line.match(/(\d+)\/(\d+)\s+ok=(\d+)/);
    if (m) {
      train.progress = Math.min(0.95, (Number(m[1]) / Number(m[2])) * 0.95);
      train.stage = `Расчёты AquaCrop: ${m[1]} из ${m[2]}`;
    } else if (/Отложенная выборка|Кросс-валидация/.test(line)) {
      train.stage = 'Обучение и проверка модели';
    } else if (/Готово/.test(line)) {
      train.stage = 'Сохранение модели';
    }
  };
  const feed = (d) => { buf += d; const parts = buf.split(/\r?\n/); buf = parts.pop(); parts.forEach(onLine); };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.on('error', (e) => { train = { ...train, state: 'error', error: `Не удалось запустить Python (${PYTHON}): ${e.message}`, finished: Date.now() }; });
  child.on('close', (code) => { if (buf) onLine(buf); if (train.state === 'running') finishTraining(dir, code, log); });
  res.json({ success: true, n });
});

app.get('/api/train/status', (req, res) => {
  const { pid, ...rest } = train;
  res.json({ success: true, ...rest, elapsed_s: train.started ? Math.round(((train.finished || Date.now()) - train.started) / 1000) : 0 });
});

app.post('/api/predict', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const params = {};
  for (const k of PARAM_KEYS) if (body[k] !== undefined && body[k] !== '' && body[k] !== null) params[k] = String(body[k]).slice(0, 120);

  const t0 = Date.now();
  const py = await runPythonQueued([JSON.stringify(params)]);
  const physicsMs = Date.now() - t0;
  if (!py.ok) {
    if (py.detail) console.error('Ошибка расчёта:', py.detail);
    return res.status(py.userError ? 400 : 500).json({ success: false, error: py.error });
  }
  const result = { ...py.data, physics_ms: physicsMs };
  const ai = result.ai || {};
  delete result.ai;
  result.ai_yield = null;
  if (!session) {
    result.ai_error = aiLoadError || 'ИИ-модель не загружена';
  } else if (!ai.applicable) {
    result.ai_error = ai.reason || 'ИИ не применим к выбранным файлам';
  } else {
    try {
      const p = await predictAI(ai.features);
      result.ai_yield = p.value;
      result.ai_ms = p.ms;
      result.ai_in_domain = !(ai.notes && ai.notes.length);
      result.ai_note = (ai.notes || []).join('; ') || null;
      result.ai_metrics = meta.metrics || null;
    } catch (e) {
      result.ai_error = e.message;
    }
  }
  res.json(result);
});

if (require.main === module) {
  loadModel().then(() => app.listen(PORT, () => console.log(`KUCrop: http://localhost:${PORT}  (python: ${PYTHON})`)));
}

module.exports = { safeName };
