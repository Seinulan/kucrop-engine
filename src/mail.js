'use strict';
/**
 * Отправка писем через HTTP-API почтового сервиса (Brevo или Resend).
 * SMTP не используется: на бесплатных хостингах (Render и др.) почтовые порты закрыты.
 */
const { MAIL } = require('./config');
const { msg, HttpError } = require('./messages');

const enabled = () => Boolean(MAIL.from && (MAIL.brevoKey || MAIL.resendKey));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function post(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`почтовый сервис ответил ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

async function send({ to, subject, text, html }) {
  if (!enabled()) throw new HttpError(503, 'no_mail');
  try {
    if (MAIL.brevoKey) {
      await post(MAIL.brevoUrl, { 'api-key': MAIL.brevoKey },
        { sender: { email: MAIL.from, name: MAIL.fromName }, to: [{ email: to }], subject, textContent: text, htmlContent: html });
    } else {
      await post(MAIL.resendUrl, { Authorization: `Bearer ${MAIL.resendKey}` },
        { from: `${MAIL.fromName} <${MAIL.from}>`, to: [to], subject, text, html });
    }
  } catch (e) {
    console.error('Письмо не отправлено:', e.message);
    throw new HttpError(502, 'mail_failed');
  }
}

/** Письмо с одной кнопкой-ссылкой: kind = 'verify' | 'reset'. */
function sendLink(kind, lang, user, link, vars) {
  const text = msg(lang, `mail_${kind}_text`, { name: user.name || user.email, ...vars });
  const button = msg(lang, `mail_${kind}_button`);
  const ignore = msg(lang, 'mail_ignore');
  return send({
    to: user.email,
    subject: msg(lang, `mail_${kind}_subject`),
    text: `${text}\n\n${button}: ${link}\n\n${ignore}`,
    html: `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#163021;max-width:520px">
<p>${esc(text)}</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#163021;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:bold">${esc(button)}</a></p>
<p style="font-size:13px;color:#5b6b60">${esc(link)}</p>
<p style="font-size:13px;color:#5b6b60">${esc(ignore)}</p>
</div>`,
  });
}

module.exports = { enabled, send, sendLink };
