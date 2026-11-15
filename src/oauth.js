'use strict';
/**
 * Вход через Google и Facebook (OAuth 2.0, код авторизации). Библиотеки не нужны: три HTTP-запроса.
 *   1. /api/auth/<провайдер>            - отправляем человека на страницу входа сервиса;
 *   2. /api/auth/<провайдер>/callback   - сервис возвращает код; меняем его на токен и узнаём почту и имя;
 *   3. находим или создаём аккаунт KUCrop, открываем сессию и возвращаем на сайт.
 * Параметр state хранится в cookie и сверяется при возврате: чужой сайт не может подсунуть свой вход.
 */
const crypto = require('crypto');
const auth = require('./auth');
const db = require('./db');
const { HttpError } = require('./messages');
const { OAUTH, OAUTH_COOKIE } = require('./config');

const configured = (name) => Boolean(db.enabled() && OAUTH[name] && OAUTH[name].id && OAUTH[name].secret);
const redirectUri = (req, name) => `${auth.baseUrl(req)}/api/auth/${name}/callback`;

function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader('Location', url);
  res.end();
}

async function getJson(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${new URL(url).host} ответил ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function fetchProfile(name, cfg, code, redirect_uri) {
  if (name === 'google') {
    const token = await getJson(cfg.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: cfg.id, client_secret: cfg.secret, redirect_uri, grant_type: 'authorization_code' }) });
    const u = await getJson(cfg.userUrl, { headers: { Authorization: `Bearer ${token.access_token}` } });
    return { id: String(u.sub || ''), email: u.email, emailVerified: u.email_verified === true || u.email_verified === 'true', name: u.name };
  }
  const token = await getJson(`${cfg.tokenUrl}?${new URLSearchParams({ client_id: cfg.id, client_secret: cfg.secret, redirect_uri, code })}`);
  const proof = crypto.createHmac('sha256', cfg.secret).update(String(token.access_token)).digest('hex');
  const u = await getJson(`${cfg.userUrl}?${new URLSearchParams({ fields: 'id,name,email', access_token: token.access_token, appsecret_proof: proof })}`);
  // Facebook не сообщает, подтверждена ли почта, поэтому к уже существующему аккаунту по ней не привязываем
  return { id: String(u.id || ''), email: u.email, emailVerified: false, name: u.name };
}

function start(name) {
  return (req, res) => {
    if (!configured(name)) return redirect(res, '/#/account?error=oauth_off');
    const cfg = OAUTH[name];
    const state = crypto.randomBytes(24).toString('base64url');
    auth.setCookie(req, res, OAUTH_COOKIE, `${name}.${state}`, 600, '/api/auth');
    const params = { client_id: cfg.id, redirect_uri: redirectUri(req, name), response_type: 'code', scope: cfg.scope, state };
    if (name === 'google') params.prompt = 'select_account';
    redirect(res, `${cfg.authUrl}?${new URLSearchParams(params)}`);
  };
}

function callback(name) {
  return async (req, res) => {
    try {
      if (!configured(name)) throw new HttpError(503, 'oauth_off');
      const expected = auth.readCookie(req, OAUTH_COOKIE);
      auth.setCookie(req, res, OAUTH_COOKIE, '', 0, '/api/auth');
      const state = String(req.query.state || '');
      if (!state || expected.length !== name.length + 1 + state.length
        || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(`${name}.${state}`))) throw new HttpError(400, 'oauth_state');
      if (req.query.error || !req.query.code) throw new HttpError(400, 'oauth_cancel');
      let profile;
      try { profile = await fetchProfile(name, OAUTH[name], String(req.query.code), redirectUri(req, name)); } catch (e) {
        console.error(`Вход через ${name}:`, e.message);
        throw new HttpError(502, 'oauth_failed');
      }
      if (!profile.id) throw new HttpError(502, 'oauth_failed');
      const user = await auth.oauthUser(name, profile);
      await auth.startSession(req, res, user);
      redirect(res, `/#/account?signed=${name}`);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(`Вход через ${name}:`, e);
      const code = e instanceof HttpError ? e.key : (db.isConnectionError(e) ? 'db_down' : 'oauth_failed');
      redirect(res, `/#/account?error=${code}`);
    }
  };
}

module.exports = { configured, start, callback };
