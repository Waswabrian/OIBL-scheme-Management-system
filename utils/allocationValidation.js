const normalizeSchemeValues = (value) => {
  if (Array.isArray(value)) {
    return value.flatMap(normalizeSchemeValues);
  }

  if (value === undefined || value === null || value === '') {
    return [];
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry && entry !== 'null' && entry !== 'undefined');
  }

  return [String(value)];
};

const validateAllocationRequest = (body = {}) => {
  const staffId = Number(body.staff_id);
  const normalizedStaffId = Number.isInteger(staffId) && staffId > 0 ? staffId : null;

  const rawSchemeIds = normalizeSchemeValues(body.scheme_ids);
  const schemeIds = [...new Set(
    rawSchemeIds
      .map((schemeId) => Number(schemeId))
      .filter((schemeId) => Number.isInteger(schemeId) && schemeId > 0)
  )].map(String);

  if (!normalizedStaffId) {
    return {
      valid: false,
      error: 'Select a staff member before saving allocations.'
    };
  }

  if (!schemeIds.length) {
    return {
      valid: false,
      error: 'Select at least one scheme to allocate.'
    };
  }

  return {
    valid: true,
    staffId: normalizedStaffId,
    schemeIds
  };
};

module.exports = { validateAllocationRequest };
