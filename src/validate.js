'use strict';
/**
 * Declarative input validation (whitelist-based).
 * - Unknown fields are dropped (mass-assignment protection).
 * - Strings are trimmed unless the rule says `noTrim` (passwords).
 * - Every failure is collected, so the UI can highlight all bad fields at once.
 */
const { ApiError } = require('./errors');

const rule = (type) => (opts = {}) => ({ type, ...opts });
const T = {
  str: rule('str'),
  int: rule('int'),
  enum: (values, opts = {}) => ({ type: 'enum', values, ...opts }),
  bool: rule('bool'),
  date: rule('date'),
};

const PASSWORD_POLICY = 'Password must be 8-72 characters and contain at least one letter and one number.';
const passwordRule = (opts = {}) => T.str({
  noTrim: true, min: 8, max: 72, label: 'Password',
  custom: (v) => (/[A-Za-z]/.test(v) && /\d/.test(v) ? undefined : PASSWORD_POLICY),
  minMessage: PASSWORD_POLICY, maxMessage: PASSWORD_POLICY, ...opts,
});

function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function validate(schema, input, { partial = false } = {}) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  const details = [];
  const fail = (field, message) => details.push({ field, message });

  for (const [field, r] of Object.entries(schema)) {
    const label = r.label || field.replace(/_/g, ' ');
    let v = src[field];
    if (typeof v === 'number' && r.type === 'str') v = String(v);
    if (typeof v === 'string' && !r.noTrim) v = v.trim();

    const empty = v === undefined || v === null || v === '';
    if (empty) {
      if (partial && v === undefined) continue;
      if (r.required) { fail(field, `${label} is required.`); continue; }
      if ('default' in r && v === undefined) out[field] = r.default;
      else if (v !== undefined && r.nullable) out[field] = null;
      continue;
    }

    switch (r.type) {
      case 'str': {
        if (typeof v !== 'string') { fail(field, `${label} must be text.`); break; }
        if (r.lower) v = v.toLowerCase();
        if (r.upper) v = v.toUpperCase();
        if (r.transform) v = r.transform(v);
        if (r.min && v.length < r.min) { fail(field, r.minMessage || `${label} must be at least ${r.min} characters.`); break; }
        if (r.max && v.length > r.max) { fail(field, r.maxMessage || `${label} must be at most ${r.max} characters.`); break; }
        if (r.pattern && !r.pattern.test(v)) { fail(field, r.patternMessage || `${label} is not in a valid format.`); break; }
        const custom = r.custom && r.custom(v);
        if (custom) { fail(field, custom); break; }
        out[field] = v;
        break;
      }
      case 'int': {
        const n = typeof v === 'number' ? v : (/^-?\d+$/.test(String(v)) ? Number(v) : NaN);
        if (!Number.isInteger(n)) { fail(field, `${label} must be a whole number.`); break; }
        if (r.min !== undefined && n < r.min) { fail(field, `${label} must be at least ${r.min}.`); break; }
        if (r.max !== undefined && n > r.max) { fail(field, `${label} must be at most ${r.max}.`); break; }
        out[field] = n;
        break;
      }
      case 'enum': {
        if (!r.values.includes(v)) { fail(field, `${label} must be one of: ${r.values.join(', ')}.`); break; }
        out[field] = v;
        break;
      }
      case 'bool': {
        if (v === true || v === 'true' || v === 1 || v === '1') out[field] = true;
        else if (v === false || v === 'false' || v === 0 || v === '0') out[field] = false;
        else fail(field, `${label} must be true or false.`);
        break;
      }
      case 'date': {
        if (typeof v !== 'string' || !isRealDate(v)) fail(field, `${label} must be a valid date (YYYY-MM-DD).`);
        else out[field] = v;
        break;
      }
      default:
        throw new Error(`Unknown validation type: ${r.type}`);
    }
  }

  if (details.length) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', details);
  }
  return out;
}

/** Positive-integer route parameter; anything else is simply "not found". */
function idParam(ctx, name = 'id') {
  const raw = ctx.params[name];
  if (!/^\d{1,12}$/.test(raw || '') || Number(raw) < 1) {
    throw new ApiError(404, 'NOT_FOUND', 'The requested record was not found.');
  }
  return Number(raw);
}

/** LIKE pattern with user wildcards neutralised. Use with ESCAPE '\'. */
function likePattern(q) {
  return `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

module.exports = { T, validate, passwordRule, PASSWORD_POLICY, idParam, likePattern, isRealDate };
