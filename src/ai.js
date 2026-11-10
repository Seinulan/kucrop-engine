'use strict';
/** ИИ-модель (ONNX). Признаки считает Python (kucrop_core.ai_block), Node только выполняет модель. */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');
const { msg } = require('./messages');

let ort = null, session = null, meta = null, loadError = null;   // loadError: { key, vars }

async function loadModel() {
  try {
    meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'model_meta.json'), 'utf8'));
    ort = require('onnxruntime-node');
    session = await ort.InferenceSession.create(path.join(ROOT, 'aquacrop_model.onnx'));
    const m = meta.metrics || {};
    console.log(`ИИ-модель: ${meta.model || '?'}, год ${meta.target_year}, ${meta.feature_names.length} признаков, R2=${m.r2_test}, RMSE=${m.rmse_test_t_ha} т/га`);
  } catch (e) {
    session = null;
    loadError = e.code === 'ENOENT' ? { key: 'no_model' } : { key: 'model_load', vars: { msg: e.message } };
    console.warn('ВНИМАНИЕ:', msg('ru', loadError.key, loadError.vars));
  }
}

const loaded = () => Boolean(session);
const offReason = (lang) => msg(lang, loadError ? loadError.key : 'model_off', loadError && loadError.vars);

/** Блок "ai" для /api/config. */
function describe(lang) {
  if (!session) return { available: false, reason: offReason(lang) };
  return { available: true, model: meta.model, target_year: meta.target_year, metrics: meta.metrics, speed: meta.speed,
    n_samples: meta.n_samples, ranges: meta.ranges, files: meta.training_file_names, trained_at: meta.trained_at,
    feature_importance: meta.feature_importance, exporter: meta.exporter, categories: meta.categories };
}

/** Дополняет результат физики прогнозом ИИ (или причиной, почему его нет). */
async function apply(result, ai, lang) {
  result.ai_yield = null;
  if (!session) { result.ai_error = offReason(lang); return; }
  if (!ai.applicable) { result.ai_error = ai.reason || msg(lang, 'ai_na'); return; }
  try {
    const input = new ort.Tensor('float32', Float32Array.from(ai.features), [1, ai.features.length]);
    const t = process.hrtime.bigint();
    const out = await session.run({ [meta.input_name || session.inputNames[0]]: input });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    const v = Number(out[session.outputNames[0]].data[0]);
    if (!Number.isFinite(v)) { result.ai_error = msg(lang, 'ai_nan'); return; }
    result.ai_yield = Math.round(Math.max(0, v) * 100) / 100;
    result.ai_ms = ms;
    result.ai_in_domain = !(ai.notes && ai.notes.length);
    result.ai_note = (ai.notes || []).join('; ') || null;
    result.ai_metrics = meta.metrics || null;
  } catch (e) {
    result.ai_error = e.message;
  }
}

module.exports = { loadModel, loaded, describe, apply };
