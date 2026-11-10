'use strict';
/**
 * KUCrop - бэкенд (Node.js + Express + PostgreSQL). Точка входа: собирает приложение из модулей в src/.
 *
 *   src/config.js      настройки и лимиты            src/routes/simulate.js  GET /api/config, POST /api/predict
 *   src/messages.js    тексты сервера RU/KZ/EN       src/routes/files.js     /api/files
 *   src/python.js      запуск физики AquaCrop        src/routes/auth.js      /api/auth/*
 *   src/ai.js          ИИ-модель (ONNX)              src/routes/history.js   /api/simulations
 *   src/db.js          PostgreSQL и миграции (db/migrations/*.sql)
 *   src/auth.js        аккаунты и сессии             src/storage.js  файлы AquaCrop     src/history.js  история расчётов
 *
 * База данных подключается переменной DATABASE_URL. Без неё сервер работает без аккаунтов: файлы общие, истории нет.
 */
const path = require('path');
const express = require('express');
const { ROOT, PORT, PYTHON } = require('./src/config');
const ai = require('./src/ai');
const db = require('./src/db');
const { safeName } = require('./src/storage');

const app = express();
app.use(express.json({ limit: '4mb' }));

// проверка живости для хостинга: мгновенный ответ, ни Python, ни база не трогаются
app.get('/healthz', (req, res) => res.json({ ok: true, ai_loaded: ai.loaded(), database: db.enabled() }));

app.use(express.static(path.join(ROOT, 'public')));

require('./src/routes/simulate')(app);
require('./src/routes/files')(app);
require('./src/routes/auth')(app);
require('./src/routes/history')(app);

async function start() {
  await ai.loadModel();
  if (db.enabled()) {
    // миграции применяются при старте; если база спит или недоступна, сервер всё равно поднимается и подключится позже
    await db.ready().then(() => console.log('База данных: подключена'), () => {});
  } else {
    console.log('База данных: не подключена (нет DATABASE_URL) - аккаунты и история выключены');
  }
  app.listen(PORT, () => console.log(`KUCrop: http://localhost:${PORT}  (python: ${PYTHON})`));
}

if (require.main === module) start();

module.exports = { app, safeName };
