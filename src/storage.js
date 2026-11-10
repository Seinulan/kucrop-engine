'use strict';
/**
 * Файлы AquaCrop.
 *   Встроенные (пример Poltavka) лежат в корне проекта и видны всем.
 *   Свои файлы: без базы данных - общая папка user_files/, как раньше;
 *               с базой - таблица files, у каждого пользователя свои. Python читает файлы с диска, поэтому
 *               содержимое базы выкладывается в папку user_files/u_<id>/ (кеш: при перезапуске сервера
 *               восстанавливается из базы, так что файлы не теряются на хостинге с временным диском).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { ROOT, USER_ROOT, EXTENSIONS, MAX_UPLOAD_BYTES, MAX_FILES_PER_USER } = require('./config');
const { msg, HttpError } = require('./messages');
const { runPythonQueued, dropConfig } = require('./python');

const PREFIX = 'user_files/';
const MAX_SYNCED_USERS = 200;

function safeName(name, lang = 'ru') {
  const base = path.basename(String(name || ''));
  const ext = path.extname(base).toLowerCase();
  if (!EXTENSIONS.includes(ext)) throw HttpError.text(400, msg(lang, 'ext', { list: EXTENSIONS.join(' ').toUpperCase() }));
  if (base.length > 80 || base.startsWith('.') || !/^[\p{L}\p{N} _.()-]+$/u.test(base)) throw new HttpError(400, 'name');
  return base;
}

/** Чьи файлы видит запрос: общая папка (без базы), папка пользователя или пустая папка гостя. */
function scopeFor(user) {
  if (!db.enabled()) return { key: 'shared', dir: USER_ROOT, user: null, canWrite: true };
  if (user) return { key: `u${user.id}`, dir: path.join(USER_ROOT, `u_${user.id}`), user, canWrite: true };
  return { key: 'guest', dir: path.join(USER_ROOT, '_guest'), user: null, canWrite: false };
}

/* ---------- выкладка файлов пользователя из базы на диск (один раз после старта сервера) ---------- */
const synced = new Map();            // id пользователя -> Promise

function ensureSynced(scope) {
  if (!scope.user) return Promise.resolve();
  const id = String(scope.user.id);
  if (!synced.has(id)) {
    if (synced.size >= MAX_SYNCED_USERS) {          // давно не заходившие: убрать кеш с диска, в базе файлы остаются
      const oldest = synced.keys().next().value;
      synced.delete(oldest);
      fs.rmSync(path.join(USER_ROOT, `u_${oldest}`), { recursive: true, force: true });
    }
    synced.set(id, (async () => {
      const sql = await db.ready();
      const rows = await sql`SELECT name, content FROM files WHERE user_id = ${id}`;
      fs.rmSync(scope.dir, { recursive: true, force: true });
      fs.mkdirSync(scope.dir, { recursive: true });
      for (const r of rows) fs.writeFileSync(path.join(scope.dir, safeName(r.name)), r.content);
    })().catch((e) => { synced.delete(id); throw e; }));
  }
  return synced.get(id);
}

function pathById(scope, id, lang) {
  const s = String(id || '');
  if (s.startsWith(PREFIX)) return path.join(scope.dir, safeName(s.slice(PREFIX.length), lang));
  return path.join(ROOT, safeName(s, lang));
}

const sameName = (dir, name) => (fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => n.toLowerCase() === name.toLowerCase()) : undefined);

/** Загрузка: файл проверяет Python (разбор формата AquaCrop); негодный файл не сохраняется. */
async function upload(scope, rawName, buf, lang) {
  if (!scope.canWrite) throw new HttpError(401, 'need_login_files');
  const name = safeName(rawName, lang);
  if (!buf.length) throw new HttpError(400, 'empty');
  if (buf.length > MAX_UPLOAD_BYTES) throw new HttpError(400, 'too_big');
  await ensureSynced(scope);
  fs.mkdirSync(scope.dir, { recursive: true });

  const old = sameName(scope.dir, name);                       // то же имя без учёта регистра = замена
  if (!old && fs.readdirSync(scope.dir).length >= MAX_FILES_PER_USER) throw new HttpError(400, 'too_many_files', { n: MAX_FILES_PER_USER });
  const backup = old ? fs.readFileSync(path.join(scope.dir, old)) : null;
  const target = path.join(scope.dir, name);
  const restore = () => {
    fs.rmSync(target, { force: true });
    if (old) fs.writeFileSync(path.join(scope.dir, old), backup);
  };
  if (old && old !== name) fs.rmSync(path.join(scope.dir, old));
  fs.writeFileSync(target, buf);

  const py = await runPythonQueued(['--validate', target], lang, scope.dir);
  if (!py.ok) { restore(); throw HttpError.text(400, py.error); }
  if (scope.user) {
    try {
      const sql = await db.ready();
      const kind = path.extname(name).slice(1).toLowerCase();
      await sql`
        INSERT INTO files (user_id, name, kind, content, size_bytes, sha256)
        VALUES (${scope.user.id}, ${name}, ${kind}, ${buf}, ${buf.length}, ${crypto.createHash('sha256').update(buf).digest('hex')})
        ON CONFLICT (user_id, lower(name)) DO UPDATE
          SET name = EXCLUDED.name, kind = EXCLUDED.kind, content = EXCLUDED.content, size_bytes = EXCLUDED.size_bytes,
              sha256 = EXCLUDED.sha256, updated_at = now()`;
    } catch (e) { restore(); throw e; }
  }
  dropConfig(scope);
  return { replaced: Boolean(old), ...py.data };
}

async function remove(scope, id, lang) {
  if (!String(id || '').startsWith(PREFIX)) throw new HttpError(400, 'only_user');
  if (!scope.canWrite) throw new HttpError(401, 'need_login');
  await ensureSynced(scope);
  const p = pathById(scope, id, lang);
  if (!fs.existsSync(p)) throw new HttpError(404, 'not_found');
  if (scope.user) {
    const sql = await db.ready();
    await sql`DELETE FROM files WHERE user_id = ${scope.user.id} AND lower(name) = lower(${path.basename(p)})`;
  }
  fs.rmSync(p);
  dropConfig(scope);
}

async function read(scope, id, lang) {
  await ensureSynced(scope);
  const p = pathById(scope, id, lang);
  if (!fs.existsSync(p)) throw new HttpError(404, 'not_found');
  return { name: path.basename(p), content: fs.readFileSync(p) };
}

module.exports = { safeName, scopeFor, ensureSynced, upload, remove, read };
