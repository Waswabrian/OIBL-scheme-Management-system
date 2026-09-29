const assert = require('node:assert/strict');
const { validateAllocationRequest } = require('../utils/allocationValidation');

const valid = validateAllocationRequest({
  staff_id: '14',
  scheme_ids: ['3', '3', '7']
});

assert.equal(valid.valid, true, 'valid request should pass validation');
assert.deepEqual(valid.staffId, 14, 'staff id should be normalized to a number');
assert.deepEqual(valid.schemeIds, ['3', '7'], 'duplicates should be removed and order preserved');

const missingScheme = validateAllocationRequest({ staff_id: '9', scheme_ids: [] });
assert.equal(missingScheme.valid, false, 'missing scheme should be rejected');
assert.match(missingScheme.error, /scheme/i, 'missing scheme error should mention a scheme');

const missingStaff = validateAllocationRequest({ staff_id: '', scheme_ids: ['2'] });
assert.equal(missingStaff.valid, false, 'missing staff should be rejected');
assert.match(missingStaff.error, /staff/i, 'missing staff error should mention a staff member');

console.log('allocation validation tests passed');
