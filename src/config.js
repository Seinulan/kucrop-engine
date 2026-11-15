'use strict';
/** Настройки сервера: пути, лимиты, переменные окружения. */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const env = (name) => String(process.env[name] || '').trim();

module.exports = {
  ROOT,
  USER_ROOT: path.join(ROOT, 'user_files'),          // загруженные файлы на диске (при базе данных - кеш содержимого базы)
  MIGRATIONS_DIR: path.join(ROOT, 'db', 'migrations'),
  PORT: Number(process.env.PORT || 3000),
  PYTHON: process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'),
  MAX_PARALLEL: Math.max(1, Number(process.env.MAX_PARALLEL || 2)),
  PY_TIMEOUT_MS: Number(process.env.PY_TIMEOUT_MS || 120000),
  DATABASE_URL: String(process.env.DATABASE_URL || '').trim(),   // пусто = без аккаунтов, как раньше

  // Адрес сайта для ссылок в письмах и возврата после входа через Google/Facebook. Если не задан, берётся из запроса.
  PUBLIC_URL: String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, ''),

  // Вход через Google и Facebook включается, когда заданы ключи приложения. Адреса сервисов менять не нужно.
  OAUTH: {
    google: {
      id: env('GOOGLE_CLIENT_ID'), secret: env('GOOGLE_CLIENT_SECRET'), scope: 'openid email profile',
      authUrl: env('GOOGLE_AUTH_URL') || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: env('GOOGLE_TOKEN_URL') || 'https://oauth2.googleapis.com/token',
      userUrl: env('GOOGLE_USER_URL') || 'https://openidconnect.googleapis.com/v1/userinfo',
    },
    facebook: {
      id: env('FACEBOOK_APP_ID'), secret: env('FACEBOOK_APP_SECRET'), scope: 'email,public_profile',
      authUrl: env('FACEBOOK_AUTH_URL') || 'https://www.facebook.com/dialog/oauth',
      tokenUrl: env('FACEBOOK_TOKEN_URL') || 'https://graph.facebook.com/oauth/access_token',
      userUrl: env('FACEBOOK_USER_URL') || 'https://graph.facebook.com/me',
    },
  },

  // Письма (подтверждение почты, сброс пароля) идут через HTTP-API: почтовые порты на бесплатном хостинге закрыты.
  // Нужен MAIL_FROM и один из ключей: BREVO_API_KEY или RESEND_API_KEY. Без них почта не подтверждается.
  MAIL: {
    from: env('MAIL_FROM'), fromName: env('MAIL_FROM_NAME') || 'KUCrop',
    brevoKey: env('BREVO_API_KEY'), brevoUrl: env('BREVO_API_URL') || 'https://api.brevo.com/v3/smtp/email',
    resendKey: env('RESEND_API_KEY'), resendUrl: env('RESEND_API_URL') || 'https://api.resend.com/emails',
  },
  VERIFY_HOURS: 24,          // срок жизни ссылки подтверждения почты
  RESET_MINUTES: 60,         // срок жизни ссылки сброса пароля
  OAUTH_COOKIE: 'kucrop_oauth',

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
