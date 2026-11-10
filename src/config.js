'use strict';
/** Настройки сервера: пути, лимиты, переменные окружения. */
const path = require('path');

const ROOT = path.join(__dirname, '..');

module.exports = {
  ROOT,
  USER_ROOT: path.join(ROOT, 'user_files'),          // загруженные файлы на диске (при базе данных - кеш содержимого базы)
  MIGRATIONS_DIR: path.join(ROOT, 'db', 'migrations'),
  PORT: Number(process.env.PORT || 3000),
  PYTHON: process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'),
  MAX_PARALLEL: Math.max(1, Number(process.env.MAX_PARALLEL || 2)),
  PY_TIMEOUT_MS: Number(process.env.PY_TIMEOUT_MS || 120000),
  DATABASE_URL: String(process.env.DATABASE_URL || '').trim(),   // пусто = без аккаунтов, как раньше

  MAX_UPLOAD_BYTES: 2 * 1024 * 1024,
  MAX_FILES_PER_USER: 60,
  MAX_HISTORY_PER_USER: 200,
  HISTORY_PAGE: 100,
  SESSION_DAYS: 30,
  SESSION_COOKIE: 'kucrop_sid',
  PASSWORD_MIN: 8,
  PASSWORD_MAX: 200,
  LOGIN_ATTEMPTS: 10,                                // неудачных попыток входа за окно
  LOGIN_WINDOW_MS: 15 * 60 * 1000,

  EXTENSIONS: ['.cro', '.sol', '.gwt', '.man', '.cli', '.tnx', '.eto', '.plu'],
  LANGS: ['ru', 'kk', 'en'],
  // crop/soil - старый формат запроса
  PARAM_KEYS: ['cliFile', 'cropFile', 'soilFile', 'gwtFile', 'manFile', 'startDate', 'gwDepth', 'initWater', 'irrigation', 'crop', 'soil'],
  MARK_RE: /---JSON_OUTPUT_START---\s*([\s\S]*?)\s*---JSON_OUTPUT_END---/,
};
