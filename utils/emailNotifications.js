require('dotenv').config();
const nodemailer = require('nodemailer');

const getMailConfig = () => {
  const host = String(process.env.SMTP_HOST || '').trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();
  const from = String(process.env.MAIL_FROM || user).trim();

  if (!host || !Number.isFinite(port) || !user || !pass || !from) {
    return null;
  }

  return {
    host,
    port,
    secure,
    auth: { user, pass },
    from,
    tls: secure ? undefined : { ciphers: 'TLSv1.2' }
  };
};

const sendAppEmail = async ({ to, subject, text, html }) => {
  if (!to) return { sent: false, reason: 'Missing recipient' };

  const recipients = (Array.isArray(to) ? to : [to])
    .map((address) => String(address || '').trim())
    .filter(Boolean);

  if (!recipients.length) return { sent: false, reason: 'Missing recipient' };

  const config = getMailConfig();
  if (!config) {
    return { sent: false, reason: 'SMTP is not configured' };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.auth,
      tls: config.tls
    });

    await transporter.verify();

    const info = await transporter.sendMail({
      from: config.from,
      to: recipients.join(', '),
      subject: subject || 'OIBL Schemes Notification',
      text: text || '',
      html: html || undefined
    });

    return {
      sent: true,
      messageId: info.messageId,
      accepted: info.accepted || recipients
    };
  } catch (error) {
    console.error('[mail] sendAppEmail failed:', error.message);
    return { sent: false, reason: error.message };
  }
};

module.exports = {
  getMailConfig,
  sendAppEmail
};
