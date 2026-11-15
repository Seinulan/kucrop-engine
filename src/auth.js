'use strict';
/**
 * Аккаунты: регистрация, вход, сессии, подтверждение почты, сброс пароля, вход через Google и Facebook.
 *   - пароль хранится только как scrypt-хеш с отдельной солью на каждого пользователя;
 *   - сессия - случайный токен в cookie (HttpOnly, SameSite=Lax); в базе лежит только его SHA-256;
 *   - ссылки из писем одноразовые и с ограниченным сроком; в базе только SHA-256 токена;
 *   - неудачные попытки входа и отправка писем ограничены по адресу и по почте.
 */
const crypto = require('crypto');
const { promisify } = require('util');
const db = require('./db');
const mail = require('./mail');
const { HttpError, langOf } = require('./messages');
const { SESSION_DAYS, SESSION_COOKIE, PASSWORD_MIN, PASSWORD_MAX, LOGIN_ATTEMPTS, LOGIN_WINDOW_MS, PUBLIC_URL,
  VERIFY_HOURS, RESET_MINUTES } = require('./config');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const USER_COLS = ['id', 'email', 'name', 'created_at', 'email_verified_at'];

/* ---------- пароли ---------- */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const [alg, n, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const key = await scrypt(String(password).normalize('NFKC'), Buffer.from(salt, 'base64'), want.length, { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}

// чтобы вход с несуществующей почтой занимал столько же времени, сколько с неверным паролем
let dummyHash = null;
const getDummyHash = async () => (dummyHash || (dummyHash = await hashPassword(crypto.randomBytes(12).toString('hex'))));

/* ---------- ограничение попыток ---------- */
const attempts = new Map();          // ключ -> { n, until }
function tooMany(key, limit = LOGIN_ATTEMPTS) {
  const a = attempts.get(key);
  if (!a || a.until < Date.now()) return 0;
  return a.n >= limit ? Math.ceil((a.until - Date.now()) / 60000) : 0;
}
function addAttempt(key) {
  const now = Date.now();
  if (attempts.size > 5000) for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
  const a = attempts.get(key);
  if (!a || a.until < now) attempts.set(key, { n: 1, until: now + LOGIN_WINDOW_MS }); else a.n += 1;
}
/** Бросает 429, если по любому из ключей лимит исчерпан; иначе засчитывает попытку. */
function limit(pairs) {
  const wait = Math.max(...pairs.map(([key, max]) => tooMany(key, max)));
  if (wait) throw new HttpError(429, 'too_many_attempts', { m: wait });
  pairs.forEach(([key]) => addAttempt(key));
}

/** Адрес клиента: за прокси хостинга (Render и т. п.) настоящий адрес - последний в X-Forwarded-For. */
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* ---------- cookie и адрес сайта ---------- */
const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || Boolean(req.socket && req.socket.encrypted);

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

/** Добавляет cookie, не затирая уже выставленные в этом ответе. */
function setCookie(req, res, name, value, maxAgeSec, cookiePath = '/') {
  const line = `${name}=${value}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, line) : line);
}

/** Адрес сайта для ссылок: PUBLIC_URL (на Render задаётся сам), иначе из запроса. */
const baseUrl = (req) => PUBLIC_URL || `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;

/* ---------- сессии ---------- */
const sessionCache = new Map();      // token_hash -> { user, until }: не ходим в базу на каждый запрос
const CACHE_MS = 60 * 1000;

const publicUser = (u) => (u ? { id: String(u.id), email: u.email, name: u.name, created_at: u.created_at, verified: Boolean(u.email_verified_at) } : null);

async function startSession(req, res, user) {
  const sql = await db.ready();
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400 * 1000);
  await sql`DELETE FROM sessions WHERE expires_at < now()`;
  await sql`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${sha256(token)}, ${user.id}, ${expires})`;
  setCookie(req, res, SESSION_COOKIE, token, SESSION_DAYS * 86400);
}

/** Пользователь по cookie запроса или null (гость). Без базы данных - всегда null. */
async function currentUser(req) {
  if (!db.enabled()) return null;
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length > 128) return null;
  const hash = sha256(token);
  const hit = sessionCache.get(hash);
  if (hit && hit.until > Date.now()) return hit.user;
  const sql = await db.ready();
  const rows = await sql`
    SELECT u.id, u.email, u.name, u.created_at, u.email_verified_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${hash} AND s.expires_at > now()`;
  const user = rows[0] || null;
  if (sessionCache.size > 5000) sessionCache.clear();
  sessionCache.set(hash, { user, until: Date.now() + CACHE_MS });
  return user;
}

/** Завершает все сессии пользователя (смена пароля, привязка внешнего входа к неподтверждённому аккаунту). */
async function dropSessions(sql, userId) {
  await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
  sessionCache.clear();
}

/* ---------- одноразовые ссылки из писем ---------- */
async function issueToken(sql, userId, purpose, ttlMs) {
  const token = crypto.randomBytes(32).toString('base64url');
  await sql`DELETE FROM email_tokens WHERE (user_id = ${userId} AND purpose = ${purpose}) OR expires_at < now()`;
  await sql`INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES (${sha256(token)}, ${userId}, ${purpose}, ${new Date(Date.now() + ttlMs)})`;
  return token;
}

/** Забирает токен (второй раз он уже не сработает) и возвращает пользователя или бросает bad_token. */
async function consumeToken(sql, token, purpose) {
  const t = String(token || '');
  if (!t || t.length > 128) throw new HttpError(400, 'bad_token');
  const [row] = await sql`DELETE FROM email_tokens WHERE token_hash = ${sha256(t)} AND purpose = ${purpose} AND expires_at > now() RETURNING user_id`;
  if (!row) throw new HttpError(400, 'bad_token');
  return row.user_id;
}

async function sendVerify(req, sql, user) {
  const token = await issueToken(sql, user.id, 'verify', VERIFY_HOURS * 3600 * 1000);
  await mail.sendLink('verify', langOf(req), user, `${baseUrl(req)}/api/auth/verify?token=${token}`, { h: VERIFY_HOURS });
}

/* ---------- действия ---------- */
function cleanEmail(v) {
  const email = String(v || '').trim();
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new HttpError(400, 'bad_email');
  return email;
}
function cleanPassword(v) {
  const password = typeof v === 'string' ? v : '';
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) throw new HttpError(400, 'bad_password', { min: PASSWORD_MIN });
  return password;
}

/**
 * Регистрация. Если на сервере настроена почта, аккаунт начинает работать после перехода по ссылке из письма
 * (ответ { pending: true }); если не настроена - вход сразу, как раньше.
 */
async function register(req, res) {
  const body = req.body || {};
  const email = cleanEmail(body.email);
  const password = cleanPassword(body.password);
  const name = String(body.name || '').trim() || email.split('@')[0].slice(0, 80);
  if (name.length > 80) throw new HttpError(400, 'bad_name');
  const sql = await db.ready();
  limit([[`reg|${clientIp(req)}`, 20]]);
  const hash = await hashPassword(password);
  const mailOn = mail.enabled();
  let user;
  const [old] = await sql`
    SELECT id, email_verified_at, (SELECT count(*)::int FROM oauth_accounts o WHERE o.user_id = users.id) AS oauth
    FROM users WHERE lower(email) = lower(${email})`;
  if (old) {
    if (!mailOn || old.email_verified_at || old.oauth) throw new HttpError(409, 'email_taken');
    // почту никто не подтвердил: её мог занять посторонний. Пароль заменяется, письмо уходит настоящему владельцу ящика.
    [user] = await sql`UPDATE users SET password_hash = ${hash}, name = ${name} WHERE id = ${old.id} RETURNING ${sql(USER_COLS)}`;
    await dropSessions(sql, old.id);
  } else {
    try {
      [user] = await sql`INSERT INTO users (email, name, password_hash) VALUES (${email}, ${name}, ${hash}) RETURNING ${sql(USER_COLS)}`;
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'email_taken');     // такая почта уже есть
      throw e;
    }
  }
  if (mailOn) {
    await sendVerify(req, sql, user);
    return { pending: true, email: user.email };
  }
  await startSession(req, res, user);
  return { user: publicUser(user) };
}

async function login(req, res) {
  const body = req.body || {};
  const email = String(body.email || '').trim();
  const password = typeof body.password === 'string' ? body.password : '';
  const keys = [`ip|${clientIp(req)}`, `mail|${email.toLowerCase()}`];
  const wait = Math.max(tooMany(keys[0], LOGIN_ATTEMPTS * 5), tooMany(keys[1]));
  if (wait) throw new HttpError(429, 'too_many_attempts', { m: wait });
  const sql = await db.ready();
  const [row] = email && email.length <= 254
    ? await sql`SELECT id, email, name, created_at, email_verified_at, password_hash FROM users WHERE lower(email) = lower(${email})` : [];
  const ok = await verifyPassword(password.slice(0, PASSWORD_MAX), (row && row.password_hash) || await getDummyHash());
  if (!row || !row.password_hash || !ok) {
    keys.forEach(addAttempt);
    throw new HttpError(401, 'bad_login');
  }
  attempts.delete(keys[1]);
  if (mail.enabled() && !row.email_verified_at) throw new HttpError(403, 'need_verify', { email: row.email });
  await startSession(req, res, row);
  return { user: publicUser(row) };
}

async function logout(req, res) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token && token.length <= 128 && db.enabled()) {
    const hash = sha256(token);
    sessionCache.delete(hash);
    const sql = await db.ready();
    await sql`DELETE FROM sessions WHERE token_hash = ${hash}`;
  }
  setCookie(req, res, SESSION_COOKIE, '', 0);
}

/** Переход по ссылке из письма: почта подтверждена, пользователь сразу входит. */
async function verifyEmail(req, res) {
  const sql = await db.ready();
  const userId = await consumeToken(sql, req.query.token, 'verify');
  const [user] = await sql`UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = ${userId} RETURNING ${sql(USER_COLS)}`;
  await startSession(req, res, user);
  return publicUser(user);
}

/** Повторная отправка письма с подтверждением. Ответ одинаковый, есть такой аккаунт или нет. */
async function resendVerify(req) {
  if (!mail.enabled()) throw new HttpError(503, 'no_mail');
  const email = cleanEmail((req.body || {}).email);
  limit([[`mailip|${clientIp(req)}`, 10], [`mailto|${email.toLowerCase()}`, 3]]);
  const sql = await db.ready();
  const [user] = await sql`SELECT ${sql(USER_COLS)} FROM users WHERE lower(email) = lower(${email})`;
  if (user && !user.email_verified_at) await sendVerify(req, sql, user);
}

/** «Забыли пароль»: письмо со ссылкой. Ответ одинаковый, есть такой аккаунт или нет. */
async function forgotPassword(req) {
  if (!mail.enabled()) throw new HttpError(503, 'no_mail');
  const email = cleanEmail((req.body || {}).email);
  limit([[`mailip|${clientIp(req)}`, 10], [`mailto|${email.toLowerCase()}`, 3]]);
  const sql = await db.ready();
  const [user] = await sql`SELECT ${sql(USER_COLS)} FROM users WHERE lower(email) = lower(${email})`;
  if (!user) return;
  const token = await issueToken(sql, user.id, 'reset', RESET_MINUTES * 60 * 1000);
  await mail.sendLink('reset', langOf(req), user, `${baseUrl(req)}/#/reset?token=${token}`, { m: RESET_MINUTES });
}

/** Новый пароль по ссылке из письма. Раз ссылка пришла на почту - почта подтверждена; старые сессии закрываются. */
async function resetPassword(req, res) {
  const body = req.body || {};
  const password = cleanPassword(body.password);
  const sql = await db.ready();
  const userId = await consumeToken(sql, body.token, 'reset');
  const [user] = await sql`
    UPDATE users SET password_hash = ${await hashPassword(password)}, email_verified_at = COALESCE(email_verified_at, now())
    WHERE id = ${userId} RETURNING ${sql(USER_COLS)}`;
  await dropSessions(sql, userId);
  await startSession(req, res, user);
  return { user: publicUser(user) };
}

/**
 * Пользователь для входа через Google или Facebook.
 * profile = { id, email, emailVerified, name }. Привязка к уже существующему аккаунту по почте делается, только если
 * внешний сервис подтверждает, что почта принадлежит человеку (Google); иначе чужой аккаунт можно было бы перехватить.
 */
async function oauthUser(provider, profile) {
  const sql = await db.ready();
  const result = await sql.begin(async (tx) => {
    const [linked] = await tx`
      SELECT u.id, u.email, u.name, u.created_at, u.email_verified_at
      FROM oauth_accounts o JOIN users u ON u.id = o.user_id
      WHERE o.provider = ${provider} AND o.provider_user_id = ${profile.id}`;
    if (linked) return { user: linked };
    const email = String(profile.email || '').trim();
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) throw new HttpError(400, 'oauth_no_email');
    let [user] = await tx`SELECT ${tx(USER_COLS)} FROM users WHERE lower(email) = lower(${email})`;
    let dropped = false;
    if (user) {
      if (!profile.emailVerified) throw new HttpError(409, 'oauth_email_taken');
      if (!user.email_verified_at) {
        // эту почту при регистрации никто не подтверждал: пароль мог задать посторонний - убираем его и закрываем сессии
        [user] = await tx`UPDATE users SET password_hash = NULL, email_verified_at = now() WHERE id = ${user.id} RETURNING ${tx(USER_COLS)}`;
        await tx`DELETE FROM sessions WHERE user_id = ${user.id}`;
        await tx`DELETE FROM email_tokens WHERE user_id = ${user.id}`;
        dropped = true;
      }
    } else {
      const name = String(profile.name || '').trim().slice(0, 80) || email.split('@')[0].slice(0, 80);
      [user] = await tx`
        INSERT INTO users (email, name, password_hash, email_verified_at)
        VALUES (${email}, ${name}, NULL, ${profile.emailVerified ? new Date() : null}) RETURNING ${tx(USER_COLS)}`;
    }
    await tx`INSERT INTO oauth_accounts (provider, provider_user_id, user_id, email) VALUES (${provider}, ${profile.id}, ${user.id}, ${email})`;
    return { user, dropped };
  });
  if (result.dropped) sessionCache.clear();
  return result.user;
}

module.exports = { currentUser, register, login, logout, verifyEmail, resendVerify, forgotPassword, resetPassword, oauthUser,
  startSession, publicUser, setCookie, readCookie, baseUrl, hashPassword, verifyPassword };
