'use strict';
/**
 * Central error model. Every failure leaves the API as:
 *   { "error": { "code": "BORROW_LIMIT", "message": "...", "details": [...], "requestId": "..." } }
 */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Codes raised by RAISE(ABORT, '<CODE>') inside schema.sql triggers.
const TRIGGER_CODES = {
  BORROW_LIMIT: [409, 'The borrowing limit has been reached.'],
  MEMBER_SUSPENDED: [409, 'This member account is suspended and cannot borrow.'],
  OUT_OF_STOCK: [409, 'No copies of this book are currently available.'],
  LOAN_ALREADY_RETURNED: [409, 'This loan has already been returned.'],
  LOAN_IMMUTABLE: [409, 'Loan details cannot be changed after issue.'],
};

const UNIQUE_MESSAGES = {
  email: ['email', 'A member with this email address already exists.'],
  isbn: ['isbn', 'A book with this ISBN already exists.'],
  username: ['username', 'This username is already taken.'],
  member_no: ['member_no', 'This member number already exists.'],
};

const isSqliteError = (err) => err && err.code === 'ERR_SQLITE_ERROR';

/** Translate low-level SQLite errors into ApiErrors (matched on message: SQLite
 *  reports FK and trigger aborts with the same extended code). Returns null if unknown. */
function fromDbError(err) {
  if (!isSqliteError(err)) return null;
  const msg = String(err.message);

  if (TRIGGER_CODES[msg]) return new ApiError(TRIGGER_CODES[msg][0], msg, TRIGGER_CODES[msg][1]);

  let m = msg.match(/^UNIQUE constraint failed: (\w+)\.(\w+)(?:, \w+\.(\w+))?/);
  if (m) {
    if (m[1] === 'loans') {
      return new ApiError(409, 'ALREADY_BORROWED', 'This member already has this title on loan.');
    }
    const [field, text] = UNIQUE_MESSAGES[m[2]] || [m[2], 'This record already exists.'];
    return new ApiError(409, 'DUPLICATE_VALUE', text, [{ field, message: text }]);
  }
  if (msg.startsWith('FOREIGN KEY constraint failed')) {
    return new ApiError(409, 'REFERENCE_CONFLICT',
      'This record is linked to other records and the change was refused.');
  }
  if (msg.startsWith('CHECK constraint failed')) {
    return new ApiError(422, 'CONSTRAINT_VIOLATION', `Data rule violated: ${msg.replace('CHECK constraint failed: ', '')}`);
  }
  if (msg.startsWith('NOT NULL constraint failed')) {
    return new ApiError(400, 'VALIDATION_ERROR', 'A required value is missing.');
  }
  return null;
}

module.exports = { ApiError, fromDbError, isSqliteError, TRIGGER_CODES };
