const crypto = require('crypto');

const generateTemporaryPassword = (length = 12) => {
  const safeLength = Math.max(10, Number(length) || 12);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let password = '';

  for (let i = 0; i < safeLength; i += 1) {
    const index = crypto.randomInt(0, chars.length);
    password += chars[index];
  }

  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return generateTemporaryPassword(safeLength);
  }

  return password;
};

const getResetPasswordRequired = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 || value === 0 ? value === 1 : false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return false;
};

const passwordMeetsPolicy = (password, minimumLength = 8) => {
  if (typeof password !== 'string') return false;
  if (password.trim().length < Number(minimumLength || 8)) return false;
  if (password.length < 8) return false;
  return /[A-Z]/.test(password) || /[a-z]/.test(password)
    ? /[A-Za-z]/.test(password) && /\d/.test(password)
    : false;
};

module.exports = {
  generateTemporaryPassword,
  getResetPasswordRequired,
  passwordMeetsPolicy
};
