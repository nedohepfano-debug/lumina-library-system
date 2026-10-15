'use strict';
/**
 * FR1 - Secure Access: authentication + role-based authorisation guards.
 *
 * Roles
 *   admin      full control (incl. deleting records, waiving fines)
 *   librarian  day-to-day operations (members, books, loans, returns, fines, reports)
 *   member     read-only access to catalogue + their own loans, fines and profile
 *
 * A guard is `(ctx) => void` that throws an ApiError to stop the request.
 */
const crypto = require('node:crypto');
const { ApiError } = require('./errors');
const { verifyToken, signToken } = require('./security');
const { parseCookies } = require('./http');

const COOKIE_NAME = 'lumina_token';
const TOKEN_TTL_SECONDS = 8 * 60 * 60;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const STAFF = ['admin', 'librarian'];

/** Changes whenever the password changes, which invalidates all older tokens. */
const fingerprint = (passwordHash) =>
  crypto.createHash('sha256').update(passwordHash).digest('hex').slice(0, 16);

function issueToken(user, secret) {
  return signToken({ sub: user.id, role: user.role, fp: fingerprint(user.password_hash) },
    secret, TOKEN_TTL_SECONDS);
}

function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (/^Bearer\s+/i.test(auth)) return { token: auth.replace(/^Bearer\s+/i, ''), via: 'bearer' };
  const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
  return cookie ? { token: cookie, via: 'cookie' } : { token: null };
}

/** Guard: requires a valid session; loads the user fresh from the DB on every request,
 *  so deactivation, role changes and password changes take effect immediately. */
function authenticate(ctx) {
  const { token, via } = extractToken(ctx.req);
  const unauthorised = () => new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
  if (!token) throw unauthorised();

  const payload = verifyToken(token, ctx.config.secret);
  if (!payload) throw unauthorised();

  const user = ctx.db.prepare(
    `SELECT u.id, u.username, u.password_hash, u.role, u.member_id, u.is_active,
            m.member_no, m.first_name, m.last_name, m.status AS member_status
       FROM users u LEFT JOIN members m ON m.id = u.member_id
      WHERE u.id = ?`).get(payload.sub);
  if (!user || !user.is_active || payload.fp !== fingerprint(user.password_hash)) throw unauthorised();

  // CSRF defence-in-depth for cookie sessions: state-changing calls must carry a custom
  // header, which browsers will not attach to cross-site requests without a CORS preflight.
  if (via === 'cookie' && !SAFE_METHODS.has(ctx.req.method)
      && ctx.req.headers['x-requested-with'] !== 'lumina-web') {
    throw new ApiError(403, 'CSRF_REJECTED', 'Request rejected: missing anti-forgery header.');
  }
  ctx.user = user;
}

/** Guard factory: the signed-in user must hold one of the given roles. */
const requireRole = (...roles) => (ctx) => {
  if (!ctx.user) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
  if (!roles.includes(ctx.user.role)) {
    throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
  }
};

const staff = [authenticate, requireRole(...STAFF)];
const adminOnly = [authenticate, requireRole('admin')];
const anyUser = [authenticate];

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    member: u.member_id
      ? { id: u.member_id, member_no: u.member_no, name: `${u.first_name} ${u.last_name}`, status: u.member_status }
      : null,
  };
}

module.exports = { authenticate, requireRole, staff, adminOnly, anyUser, issueToken, publicUser,
  fingerprint, COOKIE_NAME, TOKEN_TTL_SECONDS, STAFF };
