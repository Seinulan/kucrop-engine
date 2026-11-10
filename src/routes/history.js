'use strict';
/**
 *   GET    /api/simulations             - история расчётов пользователя (последние сверху)
 *   GET    /api/simulations/item?id=…   - сохранённый расчёт целиком: параметры и результат
 *   DELETE /api/simulations?id=…        - удалить один расчёт;  ?all=1 - очистить историю
 */
const history = require('../history');
const { route, needUser } = require('../http');

module.exports = (app) => {
  app.get('/api/simulations', route(async (req, res, ctx) => {
    res.json({ success: true, ...(await history.list(needUser(ctx))) });
  }));

  app.get('/api/simulations/item', route(async (req, res, ctx) => {
    res.json({ success: true, ...(await history.get(needUser(ctx), req.query.id)) });
  }));

  app.delete('/api/simulations', route(async (req, res, ctx) => {
    const user = needUser(ctx);
    if (req.query.all === '1') return res.json({ success: true, deleted: await history.clear(user) });
    await history.remove(user, req.query.id);
    res.json({ success: true, deleted: 1 });
  }));
};
