'use strict';
/** Запуск физики (run_aquacrop.py) с ограничением параллелизма и кеш справочника /api/config. */
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, PYTHON, MAX_PARALLEL, PY_TIMEOUT_MS, MARK_RE } = require('./config');
const { msg } = require('./messages');

let active = 0;
const queue = [];
const acquire = () => (active < MAX_PARALLEL ? (active++, Promise.resolve()) : new Promise((r) => queue.push(r)));
const release = () => { const next = queue.shift(); if (next) next(); else active--; };

/** userDir - папка с файлами того, кто делает запрос: Python видит встроенные файлы и только её. */
function runPython(args, lang, userDir) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [path.join(ROOT, 'run_aquacrop.py'), ...args],
      { cwd: ROOT, windowsHide: true, env: { ...process.env, KUCROP_USER_DIR: userDir } });
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

async function runPythonQueued(args, lang, userDir) {
  await acquire();
  try { return await runPython([...args, '--lang', lang], lang, userDir); } finally { release(); }
}

/* Справочник (библиотека файлов и сводки) зависит от языка и от того, чьи файлы видны.
   Кеш по ключу «область|язык»; сбрасывается для области при загрузке и удалении файлов. */
const CACHE_MAX = 300;
const configCache = new Map();

async function getConfig(lang, scope) {
  const key = `${scope.key}|${lang}`;
  if (configCache.has(key)) return configCache.get(key);
  const py = await runPythonQueued(['--config'], lang, scope.dir);
  if (!py.ok) throw new Error(py.error + (py.detail ? `: ${py.detail}` : ''));
  if (configCache.size >= CACHE_MAX) configCache.delete(configCache.keys().next().value);
  configCache.set(key, py.data);
  return py.data;
}

function dropConfig(scope) {
  for (const key of [...configCache.keys()]) if (key.startsWith(`${scope.key}|`)) configCache.delete(key);
}

module.exports = { runPythonQueued, getConfig, dropConfig };
