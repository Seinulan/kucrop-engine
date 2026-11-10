'use strict';
/**
 *   POST   /api/files               { name, content_b64 }  - загрузить файл AquaCrop (с базой данных - нужен вход)
 *   DELETE /api/files?id=user_files/…                      - удалить свой файл (встроенные не удаляются)
 *   GET    /api/files/download?id=…                        - скачать файл
 */
const storage = require('../storage');
const { route } = require('../http');

module.exports = (app) => {
  app.post('/api/files', route(async (req, res, { lang, scope }) => {
    const body = req.body || {};
    const buf = Buffer.from(String(body.content_b64 || ''), 'base64');
    res.json({ success: true, ...(await storage.upload(scope, body.name, buf, lang)) });
  }));

  app.delete('/api/files', route(async (req, res, { lang, scope }) => {
    await storage.remove(scope, req.query.id, lang);
    res.json({ success: true });
  }));

  app.get('/api/files/download', route(async (req, res, { lang, scope }) => {
    const file = await storage.read(scope, req.query.id, lang);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.end(file.content);
  }));
};
