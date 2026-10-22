// Email. Sends through SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM) with nodemailer.
// When SMTP isn't set, every email is printed to the server log instead of sent, so nothing goes out by accident.
const nodemailer = require('nodemailer');

let transport = null;
const configured = () => !!(process.env.SMTP_HOST && process.env.MAIL_FROM);
function getTransport() {
  if (!configured()) return null;
  if (!transport) transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT) || 587, secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
  });
  return transport;
}
async function send({ to, subject, text, replyTo }) {
  const t = getTransport();
  if (!t) {
    console.log(`\n----- EMAIL (not sent: SMTP isn't set up) -----\nTo: ${to}\nSubject: ${subject}\n\n${text}\n----- END EMAIL -----\n`);
    return { logged: true };
  }
  await t.sendMail({ from: process.env.MAIL_FROM, to, subject, text, replyTo: replyTo || process.env.MAIL_REPLY_TO || undefined });
  return { sent: true };
}
module.exports = { send, configured };
