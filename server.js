'use strict';
/**
 * KUCrop - бэкенд (Node.js + Express).
 *   GET    /api/config              - библиотека файлов AquaCrop (+ сводки), значения по умолчанию, метрики ИИ
 *   POST   /api/predict             - физический расчёт AquaCrop по выбранным файлам + прогноз ИИ (ONNX)
 *   POST   /api/files               - загрузка файла (.CRO .SOL .GWT .MAN .CLI .Tnx .ETo .PLU) в user_files/
 *   DELETE /api/files?id=...        - удалить загруженный файл (встроенные файлы не удаляются)
 *   GET    /api/files/download?id=  - скачать файл
 *
 * Признаки ИИ считает Python (kucrop_core.ai_block) - там же проверяется, что выбранные файлы
 * совпадают с файлами, на которых модель обучена. Node только выполняет ONNX.
 */
const path = require('path');
const fs = require('fs');
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
const LANGS = ['ru', 'kk', 'en'];
const PARAM_KEYS = ['cliFile', 'cropFile', 'soilFile', 'gwtFile', 'manFile', 'startDate', 'gwDepth', 'initWater', 'irrigation',
                    'crop', 'soil'];   // crop/soil - старый формат запроса

/* ---------- сообщения сервера на трёх языках ---------- */
const SM = {
  timeout: { ru: 'Расчёт превысил лимит времени ({s} с)', kk: 'Есептеу уақыт шегінен асып кетті ({s} с)', en: 'The calculation exceeded the time limit ({s} s)' },
  no_python: { ru: 'Не удалось запустить Python ({py}): {msg}. Задайте PYTHON_BIN.', kk: 'Python іске қосылмады ({py}): {msg}. PYTHON_BIN орнатыңыз.', en: 'Could not start Python ({py}): {msg}. Set PYTHON_BIN.' },
  no_result: { ru: 'Python не вернул результат', kk: 'Python нәтиже қайтармады', en: 'Python returned no result' },
  calc_error: { ru: 'Ошибка расчёта', kk: 'Есептеу қатесі', en: 'Calculation error' },
  bad_json: { ru: 'Python вернул некорректный JSON', kk: 'Python қате JSON қайтарды', en: 'Python returned invalid JSON' },
  no_model: { ru: 'Нет aquacrop_model.onnx / model_meta.json - запустите python generate_model.py', kk: 'aquacrop_model.onnx / model_meta.json жоқ — python generate_model.py іске қосыңыз', en: 'aquacrop_model.onnx / model_meta.json are missing — run python generate_model.py' },
  model_load: { ru: 'Не удалось загрузить ИИ-модель: {msg}', kk: 'ЖИ моделі жүктелмеді: {msg}', en: 'Could not load the AI model: {msg}' },
  model_off: { ru: 'ИИ-модель не загружена', kk: 'ЖИ моделі жүктелмеген', en: 'The AI model is not loaded' },
  ai_nan: { ru: 'ИИ вернул нечисловой результат', kk: 'ЖИ сандық емес нәтиже қайтарды', en: 'The AI returned a non-numeric result' },
  ai_na: { ru: 'ИИ не применим к выбранным файлам', kk: 'ЖИ таңдалған файлдарға қолданылмайды', en: 'The AI does not apply to the selected files' },
  ext: { ru: 'Можно загружать только {list}', kk: 'Тек {list} файлдарын жүктеуге болады', en: 'Only {list} files can be uploaded' },
  name: { ru: 'Имя файла: только буквы, цифры, пробел и символы _ . ( ) -, до 80 символов', kk: 'Файл аты: тек әріптер, сандар, бос орын және _ . ( ) - белгілері, 80 таңбаға дейін', en: 'File name: letters, digits, spaces and _ . ( ) - only, up to 80 characters' },
  empty: { ru: 'Пустой файл', kk: 'Бос файл', en: 'The file is empty' },
  too_big: { ru: 'Файл больше 2 МБ', kk: 'Файл 2 МБ-тан үлкен', en: 'The file is larger than 2 MB' },
  only_user: { ru: 'Удалять можно только загруженные файлы', kk: 'Тек жүктелген файлдарды жоюға болады', en: 'Only uploaded files can be deleted' },
  not_found: { ru: 'Файл не найден', kk: 'Файл табылмады', en: 'File not found' },
};
const langOf = (req) => {
  const l = String((req.get && req.get('x-lang')) || (req.query && req.query.lang) || (req.body && req.body.lang) || 'ru').toLowerCase();
  return LANGS.includes(l) ? l : 'ru';
};
const msg = (lang, key, vars = {}) => (SM[key][lang] || SM[key].ru).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
class UserError extends Error {}

/* ---------- запуск Python с ограничением параллелизма ---------- */
let active = 0;
const queue = [];
const acquire = () => (active < MAX_PARALLEL ? (active++, Promise.resolve()) : new Promise((r) => queue.push(r)));
const release = () => { const next = queue.shift(); if (next) next(); else active--; };

function runPython(args, lang = 'ru') {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [path.join(ROOT, 'run_aquacrop.py'), ...args], { cwd: ROOT, windowsHide: true });
    let out = '', err = '', done = false;
    const finish = (res) => { if (!done) { done = true; clearTimeout(timer); resolve(res); } };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: msg(lang, 'timeout', { s: PY_TIMEOUT_MS / 1000 }) });
    }, PY_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: msg(lang, 'no_python', { py: PYTHON, msg: e.message }) }));
    child.on('close', () => {
      const m = out.match(MARK_RE);
      if (!m) return finish({ ok: false, error: msg(lang, 'no_result'), detail: (err || out).slice(-800) });
      try {
        const data = JSON.parse(m[1]);
        finish(data.success === false ? { ok: false, error: data.error || msg(lang, 'calc_error'), userError: true } : { ok: true, data });
      } catch (e) {
        finish({ ok: false, error: msg(lang, 'bad_json'), detail: e.message });
      }
    });
  });
}

async function runPythonQueued(args, lang = 'ru') {
  await acquire();
  try { return await runPython([...args, '--lang', lang], lang); } finally { release(); }
}

/* ---------- справочники (кеш сбрасывается при загрузке/удалении файлов) ---------- */
let configCache = {};                               // по языкам
async function getConfig(lang) {
  if (configCache[lang]) return configCache[lang];
  const py = await runPythonQueued(['--config'], lang);
  if (!py.ok) throw new Error(py.error + (py.detail ? `: ${py.detail}` : ''));
  configCache[lang] = py.data;
  return py.data;
}

/* ---------- ИИ-модель (ONNX) ---------- */
let ort = null, session = null, meta = null, aiLoadError = null;   // aiLoadError: { key, vars }

async function loadModel() {
  try {
    meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'model_meta.json'), 'utf8'));
    ort = require('onnxruntime-node');
    session = await ort.InferenceSession.create(path.join(ROOT, 'aquacrop_model.onnx'));
    const m = meta.metrics || {};
    console.log(`ИИ-модель: ${meta.model || '?'}, год ${meta.target_year}, ${meta.feature_names.length} признаков, R2=${m.r2_test}, RMSE=${m.rmse_test_t_ha} т/га`);
  } catch (e) {
    session = null;
    aiLoadError = e.code === 'ENOENT' ? { key: 'no_model' } : { key: 'model_load', vars: { msg: e.message } };
    console.warn('ВНИМАНИЕ:', msg('ru', aiLoadError.key, aiLoadError.vars));
  }
}

async function predictAI(features) {
  const input = new ort.Tensor('float32', Float32Array.from(features), [1, features.length]);
  const t = process.hrtime.bigint();
  const out = await session.run({ [meta.input_name || session.inputNames[0]]: input });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  const v = Number(out[session.outputNames[0]].data[0]);
  if (!Number.isFinite(v)) throw new UserError('ai_nan');
  return { value: Math.round(Math.max(0, v) * 100) / 100, ms };
}

/* ---------- файлы ---------- */
function safeName(name, lang = 'ru') {
  const base = path.basename(String(name || ''));
  const ext = path.extname(base).toLowerCase();
  if (!EXTENSIONS.includes(ext)) throw new Error(msg(lang, 'ext', { list: EXTENSIONS.join(' ').toUpperCase() }));
  if (base.length > 80 || base.startsWith('.') || !/^[\p{L}\p{N} _.()-]+$/u.test(base)) {
    throw new Error(msg(lang, 'name'));
  }
  return base;
}

function fileById(id, lang) {
  const s = String(id || '');
  if (s.startsWith('user_files/')) return path.join(USER_DIR, safeName(s.slice('user_files/'.length), lang));
  return path.join(ROOT, safeName(s, lang));
}

/* ---------- HTTP ---------- */
const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/config', async (req, res) => {
  const lang = langOf(req);
  try {
    const cfg = { ...(await getConfig(lang)) };
    cfg.ai = session
      ? { available: true, model: meta.model, target_year: meta.target_year, metrics: meta.metrics, speed: meta.speed,
          n_samples: meta.n_samples, ranges: meta.ranges, files: meta.training_file_names, trained_at: meta.trained_at,
          feature_importance: meta.feature_importance, exporter: meta.exporter, categories: meta.categories }
      : { available: false, reason: msg(lang, aiLoadError ? aiLoadError.key : 'model_off', aiLoadError && aiLoadError.vars) };
    res.json(cfg);
  } catch (e) {
    res.status(503).json({ success: false, error: e.message });
  }
});

app.post('/api/files', async (req, res) => {
  const lang = langOf(req);
  let name;
  try {
    name = safeName(req.body && req.body.name, lang);
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }
  const buf = Buffer.from(String((req.body && req.body.content_b64) || ''), 'base64');
  if (!buf.length) return res.status(400).json({ success: false, error: msg(lang, 'empty') });
  if (buf.length > MAX_UPLOAD_BYTES) return res.status(400).json({ success: false, error: msg(lang, 'too_big') });

  fs.mkdirSync(USER_DIR, { recursive: true });
  const target = path.join(USER_DIR, name);
  const backup = fs.existsSync(target) ? fs.readFileSync(target) : null;
  fs.writeFileSync(target, buf);
  const py = await runPythonQueued(['--validate', target], lang);
  if (!py.ok) {                                   // файл не годится - вернуть как было
    if (backup) fs.writeFileSync(target, backup); else fs.rmSync(target, { force: true });
    return res.status(400).json({ success: false, error: py.error });
  }
  configCache = {};
  res.json({ success: true, replaced: Boolean(backup), ...py.data });
});

app.delete('/api/files', (req, res) => {
  const lang = langOf(req);
  const id = String(req.query.id || '');
  if (!id.startsWith('user_files/')) return res.status(400).json({ success: false, error: msg(lang, 'only_user') });
  let p;
  try { p = fileById(id, lang); } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
  if (!fs.existsSync(p)) return res.status(404).json({ success: false, error: msg(lang, 'not_found') });
  fs.rmSync(p);
  configCache = {};
  res.json({ success: true });
});

app.get('/api/files/download', (req, res) => {
  const lang = langOf(req);
  let p;
  try { p = fileById(req.query.id, lang); } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
  if (!fs.existsSync(p)) return res.status(404).json({ success: false, error: msg(lang, 'not_found') });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(p))}`);
  res.end(fs.readFileSync(p));
});

app.post('/api/predict', async (req, res) => {
  const lang = langOf(req);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const params = { lang };
  for (const k of PARAM_KEYS) if (body[k] !== undefined && body[k] !== '' && body[k] !== null) params[k] = String(body[k]).slice(0, 120);

  const t0 = Date.now();
  const py = await runPythonQueued([JSON.stringify(params)], lang);
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
    result.ai_error = msg(lang, aiLoadError ? aiLoadError.key : 'model_off', aiLoadError && aiLoadError.vars);
  } else if (!ai.applicable) {
    result.ai_error = ai.reason || msg(lang, 'ai_na');
  } else {
    try {
      const p = await predictAI(ai.features);
      result.ai_yield = p.value;
      result.ai_ms = p.ms;
      result.ai_in_domain = !(ai.notes && ai.notes.length);
      result.ai_note = (ai.notes || []).join('; ') || null;
      result.ai_metrics = meta.metrics || null;
    } catch (e) {
      result.ai_error = e instanceof UserError ? msg(lang, e.message) : e.message;
    }
  }
  res.json(result);
});

if (require.main === module) {
  loadModel().then(() => app.listen(PORT, () => console.log(`KUCrop: http://localhost:${PORT}  (python: ${PYTHON})`)));
}

module.exports = { safeName };
