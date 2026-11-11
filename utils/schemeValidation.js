const VALID_SCHEME_STATUSES = [
  'Draft',
  'New',
  'Pending',
  'In Progress',
  'Approved',
  'Rejected',
  'Renewed',
  'Expired',
  'Pending Feedback',
  'Lost Business'
];

const STATUS_ALIASES = {
  draft: 'Draft',
  new: 'New',
  pending: 'Pending',
  'in progress': 'In Progress',
  'in-progress': 'In Progress',
  'in_progress': 'In Progress',
  approved: 'Approved',
  rejected: 'Rejected',
  renewed: 'Renewed',
  expired: 'Expired',
  'pending feedback': 'Pending Feedback',
  'pending-feedback': 'Pending Feedback',
  'pending_feedback': 'Pending Feedback',
  'lost business': 'Lost Business',
  'lost-business': 'Lost Business',
  'lost_business': 'Lost Business'
};

const normalizeSchemeStatus = (value) => {
  if (value === undefined || value === null || value === '') {
    return 'Draft';
  }

  const normalized = String(value).trim();
  if (!normalized) return 'Draft';

  const directMatch = VALID_SCHEME_STATUSES.find((status) => status.toLowerCase() === normalized.toLowerCase());
  if (directMatch) return directMatch;

  const aliasMatch = STATUS_ALIASES[normalized.toLowerCase()];
  if (aliasMatch) return aliasMatch;

  return 'Draft';
};

const isValidSchemeStatus = (value) => {
  return VALID_SCHEME_STATUSES.some((status) => status.toLowerCase() === String(value || '').trim().toLowerCase());
};

const validateSchemeInput = (body = {}) => {
  const schemeName = String(body.scheme_name ?? '').trim();
  const insurer = String(body.insurer ?? '').trim();
  const policyType = String(body.policy_type ?? '').trim();
  const status = normalizeSchemeStatus(body.status);
  const rawPremium = body.premium;
  const premiumNumber = rawPremium === '' || rawPremium === null || rawPremium === undefined
    ? null
    : Number(rawPremium);

  if (!schemeName) {
    return {
      valid: false,
      error: 'Scheme name is required.'
    };
  }

  if (!insurer) {
    return {
      valid: false,
      error: 'Insurer is required.'
    };
  }

  if (!policyType) {
    return {
      valid: false,
      error: 'Policy type is required.'
    };
  }

  if (rawPremium !== '' && rawPremium !== null && rawPremium !== undefined && rawPremium !== ' ' && !Number.isFinite(premiumNumber)) {
    return {
      valid: false,
      error: 'Premium must be a valid number.'
    };
  }

  if (body.status !== undefined && body.status !== null && String(body.status).trim() !== '' && !isValidSchemeStatus(body.status)) {
    return {
      valid: false,
      error: 'Status must be one of: Draft, New, Pending, In Progress, Approved, Rejected, Renewed, Expired, Pending Feedback, Lost Business.'
    };
  }

  const assignedTo = body.assigned_to === undefined ? '' : String(body.assigned_to).trim();

  return {
    valid: true,
    data: {
      scheme_name: schemeName,
      insurer,
      policy_type: policyType,
      premium: premiumNumber,
      status,
      inception_date: body.inception_date ? String(body.inception_date).trim() : '',
      assigned_to: assignedTo,
      created_by: body.created_by ?? null
    }
  };
};

module.exports = {
  VALID_SCHEME_STATUSES,
  normalizeSchemeStatus,
  isValidSchemeStatus,
  validateSchemeInput
};
