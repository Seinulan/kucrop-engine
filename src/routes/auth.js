'use strict';
/**
 *   POST /api/auth/register  { email, password, name? }  - регистрация и вход
 *   POST /api/auth/login     { email, password }
 *   POST /api/auth/logout
 *   GET  /api/auth/me                                    - кто я; включены ли аккаунты; сколько файлов и расчётов
 */
const auth = require('../auth');
const db = require('../db');
const history = require('../history');
const { route, fail } = require('../http');
const { langOf } = require('../messages');

module.exports = (app) => {
  // вход и регистрация не требуют текущего пользователя, поэтому без route(): cookie может быть устаревшей
  const open = (fn, status = 200) => async (req, res) => {
    try { res.status(status).json({ success: true, user: await fn(req, res) }); } catch (e) { fail(res, e, langOf(req)); }
  };
  app.post('/api/auth/register', open(auth.register, 201));
  app.post('/api/auth/login', open(auth.login));
  app.post('/api/auth/logout', async (req, res) => {
    try { await auth.logout(req, res); res.json({ success: true }); } catch (e) { fail(res, e, langOf(req)); }
  });

  app.get('/api/auth/me', route(async (req, res, { user }) => {
    res.json({ success: true, accounts: db.enabled(), user: auth.publicUser(user), counts: user ? await history.counts(user) : null });
  }));
};
