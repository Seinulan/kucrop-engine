'use strict';
/**
 * Аккаунты: регистрация, вход, сессии.
 *   - пароль хранится только как scrypt-хеш с отдельной солью на каждого пользователя;
 *   - сессия - случайный токен в cookie (HttpOnly, SameSite=Lax); в базе лежит только его SHA-256;
 *   - неудачные попытки входа ограничены по адресу и по почте.
 */
const crypto = require('crypto');
const { promisify } = require('util');
const db = require('./db');
const { HttpError } = require('./messages');
const { SESSION_DAYS, SESSION_COOKIE, PASSWORD_MIN, PASSWORD_MAX, LOGIN_ATTEMPTS, LOGIN_WINDOW_MS } = require('./config');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

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

/** Адрес клиента: за прокси хостинга (Render и т. п.) настоящий адрес - последний в X-Forwarded-For. */
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* ---------- cookie ---------- */
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function setCookie(req, res, value, maxAgeSec) {
  const https = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || Boolean(req.socket && req.socket.encrypted);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${https ? '; Secure' : ''}`);
}

/* ---------- сессии ---------- */
const sessionCache = new Map();      // token_hash -> { user, until }: не ходим в базу на каждый запрос
const CACHE_MS = 60 * 1000;

const publicUser = (u) => (u ? { id: String(u.id), email: u.email, name: u.name, created_at: u.created_at } : null);

async function startSession(req, res, user) {
  const sql = await db.ready();
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400 * 1000);
  await sql`DELETE FROM sessions WHERE expires_at < now()`;
  await sql`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${sha256(token)}, ${user.id}, ${expires})`;
  setCookie(req, res, token, SESSION_DAYS * 86400);
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
    SELECT u.id, u.email, u.name, u.created_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${hash} AND s.expires_at > now()`;
  const user = rows[0] || null;
  if (sessionCache.size > 5000) sessionCache.clear();
  sessionCache.set(hash, { user, until: Date.now() + CACHE_MS });
  return user;
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

async function register(req, res) {
  const body = req.body || {};
  const email = cleanEmail(body.email);
  const password = cleanPassword(body.password);
  const name = String(body.name || '').trim() || email.split('@')[0].slice(0, 80);
  if (name.length > 80) throw new HttpError(400, 'bad_name');
  const ipKey = `reg|${clientIp(req)}`;
  const wait = tooMany(ipKey, 20);
  if (wait) throw new HttpError(429, 'too_many_attempts', { m: wait });
  const sql = await db.ready();
  addAttempt(ipKey);
  let user;
  try {
    [user] = await sql`
      INSERT INTO users (email, name, password_hash) VALUES (${email}, ${name}, ${await hashPassword(password)})
      RETURNING id, email, name, created_at`;
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'email_taken');     // такая почта уже есть
    throw e;
  }
  await startSession(req, res, user);
  return publicUser(user);
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
    ? await sql`SELECT id, email, name, created_at, password_hash FROM users WHERE lower(email) = lower(${email})` : [];
  const ok = await verifyPassword(password.slice(0, PASSWORD_MAX), row ? row.password_hash : await getDummyHash());
  if (!row || !ok) {
    keys.forEach(addAttempt);
    throw new HttpError(401, 'bad_login');
  }
  attempts.delete(keys[1]);
  await startSession(req, res, row);
  return publicUser(row);
}

async function logout(req, res) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token && token.length <= 128 && db.enabled()) {
    const hash = sha256(token);
    sessionCache.delete(hash);
    const sql = await db.ready();
    await sql`DELETE FROM sessions WHERE token_hash = ${hash}`;
  }
  setCookie(req, res, '', 0);
}

module.exports = { currentUser, register, login, logout, publicUser, hashPassword, verifyPassword };
