const assert = require('node:assert/strict');
const {
  validateSchemeInput,
  normalizeSchemeStatus,
  isValidSchemeStatus
} = require('../utils/schemeValidation');

assert.equal(isValidSchemeStatus('Pending'), true, 'Pending should be treated as a valid status');
assert.equal(isValidSchemeStatus('Not Real'), false, 'Unknown status should be rejected');
assert.equal(normalizeSchemeStatus('new'), 'New', 'stage values should normalize to a supported status');

const valid = validateSchemeInput({
  scheme_name: '  Family Cover  ',
  insurer: '  Octagon  ',
  policy_type: 'Medical',
  premium: '2500.50',
  status: 'Pending',
  inception_date: '2026-11-11',
  assigned_to: ' 12 '
});

assert.equal(valid.valid, true, 'valid scheme payload should pass validation');
assert.equal(valid.data.scheme_name, 'Family Cover', 'scheme names should be trimmed');
assert.equal(valid.data.status, 'Pending', 'status should remain valid');
assert.equal(valid.data.premium, 2500.5, 'premium should be converted to a number');
assert.equal(valid.data.assigned_to, '12', 'assigned_to should be trimmed');

const invalid = validateSchemeInput({ scheme_name: '', insurer: '', policy_type: '' });
assert.equal(invalid.valid, false, 'missing required scheme fields should be rejected');
assert.match(invalid.error, /scheme name/i, 'validation error should mention missing scheme name');

console.log('scheme validation tests passed');
