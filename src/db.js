'use strict';
/**
 * PostgreSQL (подходит Neon и любой другой): подключение по DATABASE_URL и SQL-миграции из db/migrations.
 * Без DATABASE_URL сервер работает как раньше - без аккаунтов и истории.
 */
const fs = require('fs');
const path = require('path');
const { DATABASE_URL, MIGRATIONS_DIR } = require('./config');
const { HttpError } = require('./messages');

const MIGRATION_LOCK = 4711002;        // один сервер применяет миграции, остальные ждут
let sql = null, readyPromise = null;

const enabled = () => Boolean(DATABASE_URL);

/** Строку подключения разбираем сами: лишние параметры из неё (channel_binding и т. п.) драйверу не передаются. */
function options(urlText) {
  const u = new URL(urlText);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const local = ['localhost', '127.0.0.1', '::1'].includes(host);
  const mode = String(u.searchParams.get('sslmode') || (local ? 'disable' : 'require')).toLowerCase();
  const opts = {
    host, port: Number(u.port || 5432),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
    username: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    ssl: mode === 'disable' ? false : (mode === 'verify-full' || mode === 'verify-ca') ? 'verify-full' : 'require',
    max: 5,                    // бесплатные базы дают немного соединений
    idle_timeout: 20,          // с: Neon усыпляет базу без запросов - не держим соединения зря
    connect_timeout: 30,       // с: пробуждение спящей базы занимает до нескольких секунд
    prepare: false,            // совместимо с пулером соединений (PgBouncer у Neon)
    onnotice: () => {},
  };
  if (u.searchParams.get('options')) opts.connection = { options: u.searchParams.get('options') };
  return opts;
}

async function migrate(db) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK}::bigint)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    const done = new Set((await tx`SELECT version FROM schema_migrations`).map((r) => r.version));
    for (const f of files) {
      if (done.has(f)) continue;
      await tx.unsafe(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
      await tx`INSERT INTO schema_migrations (version) VALUES (${f})`;
      console.log('База данных: применена миграция', f);
    }
  });
}

/** Готовое подключение (миграции применены). Если база недоступна - 503, следующая попытка подключится заново. */
function ready() {
  if (!enabled()) return Promise.reject(new HttpError(503, 'no_accounts'));
  if (!readyPromise) {
    readyPromise = (async () => {
      if (!sql) sql = require('postgres')(options(DATABASE_URL));
      await migrate(sql);
      return sql;
    })().catch((e) => {
      readyPromise = null;
      console.error('База данных недоступна:', e.message);
      throw new HttpError(503, 'db_down');
    });
  }
  return readyPromise;
}

/** Ошибка связи с базой (а не ошибка в запросе). */
function isConnectionError(e) {
  const code = String((e && e.code) || '');
  return /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|CONNECTION_|CONNECT_TIMEOUT)/.test(code) || /^(08|53|57P)/.test(code);
}

async function close() {
  if (sql) await sql.end({ timeout: 5 });
  sql = null; readyPromise = null;
}

module.exports = { enabled, ready, isConnectionError, close, options };
