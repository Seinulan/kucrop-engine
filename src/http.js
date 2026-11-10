'use strict';
/** Обёртка маршрута: язык, пользователь по cookie, область файлов и единый формат ошибок. */
const auth = require('./auth');
const db = require('./db');
const storage = require('./storage');
const { msg, langOf, HttpError } = require('./messages');

function fail(res, e, lang) {
  if (e instanceof HttpError) return res.status(e.status).json({ success: false, error: e.toText(lang), code: e.key || undefined });
  const down = db.isConnectionError(e);
  console.error(down ? 'База данных недоступна:' : 'Ошибка сервера:', e);
  return res.status(down ? 503 : 500).json({ success: false, error: msg(lang, down ? 'db_down' : 'server_error') });
}

/** fn(req, res, { lang, user, scope }). user = null для гостя; scope - чьи файлы видны (см. storage.scopeFor). */
function route(fn) {
  return async (req, res) => {
    const lang = langOf(req);
    try {
      const user = await auth.currentUser(req);
      await fn(req, res, { lang, user, scope: storage.scopeFor(user) });
    } catch (e) {
      fail(res, e, lang);
    }
  };
}

/** Для маршрутов, которым нужен вход. */
function needUser(ctx) {
  if (!db.enabled()) throw new HttpError(503, 'no_accounts');
  if (!ctx.user) throw new HttpError(401, 'need_login');
  return ctx.user;
}

module.exports = { route, needUser, fail };
