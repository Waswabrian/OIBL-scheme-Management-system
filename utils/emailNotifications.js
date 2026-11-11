require('dotenv').config();
const nodemailer = require('nodemailer');

const getMailConfig = () => {
  const host = process.env.SMTP_HOST || 'smtp.mailtrap.io';
  const port = Number(process.env.SMTP_PORT || 2525);
  const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
  const user = process.env.SMTP_USER || 'demo@oibl.local';
  const pass = process.env.SMTP_PASS || 'demo-password';
  const from = process.env.MAIL_FROM || process.env.DEFAULT_ADMIN_EMAIL || user;

  if (!host || !Number.isFinite(port)) {
    return null;
  }

  return {
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
    from
  };
};

const sendAppEmail = async ({ to, subject, text, html }) => {
  if (!to) {
    return { sent: false, reason: 'Missing recipient' };
  }

  const config = getMailConfig();
  if (!config) {
    return { sent: false, reason: 'SMTP configuration missing' };
  }

  try {
    const transporter = nodemailer.createTransport(config);
    const normalizedTo = Array.isArray(to) ? to.filter(Boolean).join(', ') : to;
    const info = await transporter.sendMail({
      from: config.from,
      to: normalizedTo,
      subject: subject || 'OIBL Scheme Update',
      text: text || '',
      html: html || undefined
    });

    return {
      sent: true,
      messageId: info.messageId,
      accepted: info.accepted || [normalizedTo]
    };
  } catch (error) {
    console.error('[mail] sendAppEmail failed:', error.message);
    return {
      sent: false,
      reason: error.message
    };
  }
};

module.exports = {
  getMailConfig,
  sendAppEmail
};
