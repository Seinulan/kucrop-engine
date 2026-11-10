'use strict';
/** История расчётов пользователя (таблица simulations). */
const crypto = require('crypto');
const db = require('./db');
const { HttpError } = require('./messages');
const { MAX_HISTORY_PER_USER, HISTORY_PAGE } = require('./config');

const ID_RE = /^\d{1,18}$/;
const baseName = (id) => String(id || '').split('/').pop();

/** Сохраняет расчёт. Тот же сценарий, что и последний сохранённый, не дублируется - запись обновляется. */
async function save(user, params, result) {
  const sql = await db.ready();
  const clean = {};
  for (const k of Object.keys(params).sort()) if (k !== 'lang') clean[k] = params[k];
  const hash = crypto.createHash('sha256').update(JSON.stringify(clean)).digest('hex');
  const start = String(result.period || '').split(' - ')[0].replace(/\//g, '-').slice(0, 10);
  const row = {
    user_id: user.id, params_hash: hash, params: sql.json(clean),
    station: String(result.station || '').slice(0, 200),
    crop: baseName((result.files && result.files.crop) || clean.cropFile).slice(0, 200),
    start_date: start, season_year: Number(result.season_year) || Number(start.slice(0, 4)),
    irrigated: result.irrigation === 'Irrigated',
    yield_t_ha: Number(result.yield_tonne_ha) || 0,
    ai_yield_t_ha: result.ai_yield == null ? null : Number(result.ai_yield),
    result: sql.json(result),
  };
  return sql.begin(async (tx) => {
    const [last] = await tx`SELECT id, params_hash FROM simulations WHERE user_id = ${user.id} ORDER BY created_at DESC, id DESC LIMIT 1`;
    let id;
    if (last && last.params_hash === hash) {
      await tx`UPDATE simulations SET ${tx(row, 'yield_t_ha', 'ai_yield_t_ha', 'result', 'station', 'crop')}, created_at = now() WHERE id = ${last.id}`;
      id = last.id;
    } else {
      [{ id }] = await tx`INSERT INTO simulations ${tx(row)} RETURNING id`;
      await tx`
        DELETE FROM simulations WHERE user_id = ${user.id} AND id NOT IN (
          SELECT id FROM simulations WHERE user_id = ${user.id} ORDER BY created_at DESC, id DESC LIMIT ${MAX_HISTORY_PER_USER})`;
    }
    return String(id);
  });
}

async function list(user) {
  const sql = await db.ready();
  const rows = await sql`
    SELECT id, created_at, station, crop, start_date::text AS start_date, season_year, irrigated,
           yield_t_ha::float8 AS yield_t_ha, ai_yield_t_ha::float8 AS ai_yield_t_ha
    FROM simulations WHERE user_id = ${user.id} ORDER BY created_at DESC, id DESC LIMIT ${HISTORY_PAGE}`;
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM simulations WHERE user_id = ${user.id}`;
  return { total: n, items: rows.map((r) => ({ ...r, id: String(r.id) })) };
}

async function get(user, id) {
  if (!ID_RE.test(String(id || ''))) throw new HttpError(404, 'sim_not_found');
  const sql = await db.ready();
  const [row] = await sql`SELECT id, created_at, params, result FROM simulations WHERE id = ${id} AND user_id = ${user.id}`;
  if (!row) throw new HttpError(404, 'sim_not_found');
  return { id: String(row.id), created_at: row.created_at, params: row.params, result: row.result };
}

async function remove(user, id) {
  if (!ID_RE.test(String(id || ''))) throw new HttpError(404, 'sim_not_found');
  const sql = await db.ready();
  const rows = await sql`DELETE FROM simulations WHERE id = ${id} AND user_id = ${user.id} RETURNING id`;
  if (!rows.length) throw new HttpError(404, 'sim_not_found');
}

async function clear(user) {
  const sql = await db.ready();
  const rows = await sql`DELETE FROM simulations WHERE user_id = ${user.id} RETURNING id`;
  return rows.length;
}

async function counts(user) {
  const sql = await db.ready();
  const [r] = await sql`
    SELECT (SELECT count(*)::int FROM files WHERE user_id = ${user.id}) AS files,
           (SELECT count(*)::int FROM simulations WHERE user_id = ${user.id}) AS simulations`;
  return r;
}

module.exports = { save, list, get, remove, clear, counts };
