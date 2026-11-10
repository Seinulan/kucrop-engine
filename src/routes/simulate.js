'use strict';
/**
 *   GET  /api/config   - библиотека файлов AquaCrop (+ сводки), значения по умолчанию, метрики ИИ, текущий пользователь
 *   POST /api/predict  - физический расчёт AquaCrop по выбранным файлам + прогноз ИИ; save: true - сохранить в историю
 */
const ai = require('../ai');
const auth = require('../auth');
const db = require('../db');
const history = require('../history');
const storage = require('../storage');
const { runPythonQueued, getConfig } = require('../python');
const { route } = require('../http');
const { msg, HttpError } = require('../messages');
const { PARAM_KEYS } = require('../config');

module.exports = (app) => {
  app.get('/api/config', route(async (req, res, { lang, user, scope }) => {
    await storage.ensureSynced(scope);
    let cfg;
    try { cfg = { ...(await getConfig(lang, scope)) }; } catch (e) { throw HttpError.text(503, e.message); }
    cfg.ai = ai.describe(lang);
    cfg.accounts = db.enabled();
    cfg.user = auth.publicUser(user);
    cfg.can_upload = scope.canWrite;
    res.json(cfg);
  }));

  app.post('/api/predict', route(async (req, res, { lang, user, scope }) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const params = { lang };
    for (const k of PARAM_KEYS) if (body[k] !== undefined && body[k] !== '' && body[k] !== null) params[k] = String(body[k]).slice(0, 120);

    await storage.ensureSynced(scope);
    const t0 = Date.now();
    const py = await runPythonQueued([JSON.stringify(params)], lang, scope.dir);
    const physicsMs = Date.now() - t0;
    if (!py.ok) {
      if (py.detail) console.error('Ошибка расчёта:', py.detail);
      throw HttpError.text(py.userError ? 400 : 500, py.error);
    }
    const result = { ...py.data, physics_ms: physicsMs };
    const aiBlock = result.ai || {};
    delete result.ai;
    await ai.apply(result, aiBlock, lang);

    if (user && body.save === true) {                 // история не должна ломать сам расчёт
      try { result.saved_id = await history.save(user, params, result); } catch (e) {
        console.error('История: расчёт не сохранён:', e.message || e);
        result.save_error = msg(lang, 'db_down');
      }
    }
    res.json(result);
  }));
};
