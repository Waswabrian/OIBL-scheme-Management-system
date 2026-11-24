const assert = require('assert');
const {
  generateTemporaryPassword,
  getResetPasswordRequired,
  passwordMeetsPolicy
} = require('../utils/passwordManagement');

const tempPassword = generateTemporaryPassword(12);
assert.equal(typeof tempPassword, 'string', 'temporary password should be a string');
assert.ok(tempPassword.length >= 12, 'temporary password should meet the requested length');
assert.ok(/[A-Za-z]/.test(tempPassword), 'temporary password should contain letters');
assert.ok(/\d/.test(tempPassword), 'temporary password should contain digits');

assert.equal(getResetPasswordRequired(1), true, 'numeric true flag should be treated as forced reset');
assert.equal(getResetPasswordRequired('true'), true, 'string true flag should be treated as forced reset');
assert.equal(getResetPasswordRequired(false), false, 'false should not trigger a forced reset');

assert.equal(passwordMeetsPolicy('Secret@123', 8), true, 'valid password should pass policy');
assert.equal(passwordMeetsPolicy('short', 8), false, 'too short password should fail policy');

console.log('password management tests passed');
