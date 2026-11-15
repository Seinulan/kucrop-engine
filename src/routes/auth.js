'use strict';
/**
 *   POST /api/auth/register  { email, password, name? }  - регистрация; при настроенной почте - письмо с подтверждением
 *   POST /api/auth/login     { email, password }
 *   POST /api/auth/logout
 *   GET  /api/auth/me                                    - кто я; включены ли аккаунты; сколько файлов и расчётов
 *   GET  /api/auth/verify?token=…                        - ссылка из письма: почта подтверждена, вход выполнен
 *   POST /api/auth/resend    { email }                   - отправить письмо с подтверждением ещё раз
 *   POST /api/auth/forgot    { email }                   - письмо со ссылкой для сброса пароля
 *   POST /api/auth/reset     { token, password }         - новый пароль по ссылке из письма
 *   GET  /api/auth/google, /api/auth/facebook            - вход через внешний сервис (+ /callback)
 */
const auth = require('../auth');
const db = require('../db');
const history = require('../history');
const oauth = require('../oauth');
const { route, fail } = require('../http');
const { langOf, HttpError } = require('../messages');

module.exports = (app) => {
  // вход и регистрация не требуют текущего пользователя, поэтому без route(): cookie может быть устаревшей
  const open = (fn, status = 200) => async (req, res) => {
    try {
      const out = (await fn(req, res)) || {};
      res.status(out.pending ? 202 : status).json({ success: true, ...out });
    } catch (e) { fail(res, e, langOf(req)); }
  };
  app.post('/api/auth/register', open(auth.register, 201));
  app.post('/api/auth/login', open(auth.login));
  app.post('/api/auth/logout', open(auth.logout));
  app.post('/api/auth/resend', open(auth.resendVerify));
  app.post('/api/auth/forgot', open(auth.forgotPassword));
  app.post('/api/auth/reset', open(auth.resetPassword));

  app.get('/api/auth/verify', async (req, res) => {
    let target = '/#/account?verified=1';
    try { await auth.verifyEmail(req, res); } catch (e) {
      if (!(e instanceof HttpError)) console.error('Подтверждение почты:', e);
      target = `/#/account?error=${e instanceof HttpError ? e.key : 'server_error'}`;
    }
    res.statusCode = 302;
    res.setHeader('Location', target);
    res.end();
  });

  for (const name of ['google', 'facebook']) {
    app.get(`/api/auth/${name}`, oauth.start(name));
    app.get(`/api/auth/${name}/callback`, oauth.callback(name));
  }

  app.get('/api/auth/me', route(async (req, res, { user }) => {
    res.json({ success: true, accounts: db.enabled(), user: auth.publicUser(user), counts: user ? await history.counts(user) : null });
  }));
};
