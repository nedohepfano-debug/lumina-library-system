'use strict';
/** FR1 - Secure Access: sign-in, sign-out, session lookup, password change. */
const { ApiError } = require('../errors');
const { T, validate, passwordRule } = require('../validate');
const { hashPassword, verifyPassword, DUMMY_HASH } = require('../security');
const { anyUser, issueToken, publicUser, COOKIE_NAME, TOKEN_TTL_SECONDS } = require('../auth');
const { serializeCookie } = require('../http');

module.exports = function register(router) {
  // POST /api/auth/login  { username, password }
  router.post('/api/auth/login', async (ctx) => {
    const { limiter, secret, production } = ctx.config;
    const key = ctx.req.socket.remoteAddress || 'unknown';
    limiter.check(key);

    const { username, password } = validate({
      username: T.str({ required: true, max: 40, label: 'Username' }),
      password: T.str({ required: true, max: 200, noTrim: true, label: 'Password' }),
    }, ctx.body);

    const user = ctx.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    // Always run one scrypt comparison so timing does not reveal valid usernames.
    const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok || !user.is_active) {
      limiter.fail(key);
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password.');
    }
    limiter.reset(key);

    const full = ctx.db.prepare(
      `SELECT u.*, m.member_no, m.first_name, m.last_name, m.status AS member_status
         FROM users u LEFT JOIN members m ON m.id = u.member_id WHERE u.id = ?`).get(user.id);
    const token = issueToken(user, secret);
    ctx.setCookies.push(serializeCookie(COOKIE_NAME, token, { maxAge: TOKEN_TTL_SECONDS, secure: production }));
    return { user: publicUser(full), token, expiresIn: TOKEN_TTL_SECONDS };
  });

  // POST /api/auth/logout
  router.post('/api/auth/logout', (ctx) => {
    ctx.setCookies.push(serializeCookie(COOKIE_NAME, '', { maxAge: 0, secure: ctx.config.production }));
    return { ok: true };
  });

  // GET /api/auth/me
  router.get('/api/auth/me', ...anyUser, (ctx) => ({ user: publicUser(ctx.user) }));

  // POST /api/auth/change-password  { current_password, new_password }
  router.post('/api/auth/change-password', ...anyUser, async (ctx) => {
    const body = validate({
      current_password: T.str({ required: true, max: 200, noTrim: true, label: 'Current password' }),
      new_password: passwordRule({ required: true, label: 'New password' }),
    }, ctx.body);

    if (!(await verifyPassword(body.current_password, ctx.user.password_hash))) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Please correct the highlighted fields.',
        [{ field: 'current_password', message: 'Current password is incorrect.' }]);
    }
    if (body.current_password === body.new_password) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Please correct the highlighted fields.',
        [{ field: 'new_password', message: 'New password must differ from the current one.' }]);
    }
    const hash = await hashPassword(body.new_password);
    ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, ctx.user.id);

    // Re-issue a session: the old token's fingerprint is now invalid.
    const token = issueToken({ ...ctx.user, password_hash: hash }, ctx.config.secret);
    ctx.setCookies.push(serializeCookie(COOKIE_NAME, token,
      { maxAge: TOKEN_TTL_SECONDS, secure: ctx.config.production }));
    return { ok: true, message: 'Password updated.', token };
  });
};
