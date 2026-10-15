'use strict';
/** FR2 - Member CRUD (staff), plus own-profile access for members. */
const { ApiError, isSqliteError } = require('../errors');
const { T, validate, passwordRule, idParam, likePattern } = require('../validate');
const { hashPassword, generateTempPassword } = require('../security');
const { staff, adminOnly, anyUser } = require('../auth');
const { tx, setting } = require('../db');

const MEMBER_SELECT = `
  SELECT m.id, m.member_no, m.first_name, m.last_name, m.email, m.phone, m.status, m.joined_at,
         (SELECT COUNT(*) FROM loans l WHERE l.member_id = m.id AND l.status = 'active') AS active_loans,
         (SELECT COUNT(*) FROM v_loan_details v WHERE v.member_id = m.id AND v.is_overdue = 1) AS overdue_loans,
         COALESCE((SELECT SUM(f.amount_zar) FROM fines f
                    WHERE f.member_id = m.id AND f.status = 'unpaid'), 0) AS unpaid_fines_zar
    FROM members m`;

const PHONE = /^[0-9+()\-\s]{7,20}$/;
const memberFields = (required) => ({
  first_name: T.str({ required, max: 60, label: 'First name' }),
  last_name: T.str({ required, max: 60, label: 'Last name' }),
  email: T.str({ required, max: 120, lower: true, label: 'Email',
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, patternMessage: 'Enter a valid email address, e.g. name@example.co.za.' }),
  phone: T.str({ nullable: true, pattern: PHONE, label: 'Phone',
    patternMessage: 'Phone may only contain digits, spaces, + ( ) and -, 7-20 characters.' }),
  status: T.enum(['active', 'suspended'], { label: 'Status' }),
});

function getMember(db, id) {
  const m = db.prepare(`${MEMBER_SELECT} WHERE m.id = ?`).get(id);
  if (!m) throw new ApiError(404, 'NOT_FOUND', 'Member not found.');
  return m;
}

module.exports = function register(router) {
  // GET /api/members?q=&status=&page=&limit=
  router.get('/api/members', ...staff, (ctx) => {
    const f = validate({
      q: T.str({ max: 80 }),
      status: T.enum(['active', 'suspended']),
      page: T.int({ min: 1, default: 1 }),
      limit: T.int({ min: 1, max: 100, default: 50 }),
    }, ctx.query);
    const q = f.q ? likePattern(f.q) : null;
    const where = `WHERE (? IS NULL OR m.first_name || ' ' || m.last_name LIKE ? ESCAPE '\\'
                      OR m.last_name || ' ' || m.first_name LIKE ? ESCAPE '\\'
                      OR m.email LIKE ? ESCAPE '\\' OR m.member_no LIKE ? ESCAPE '\\')
                     AND (? IS NULL OR m.status = ?)`;
    const params = [q, q, q, q, q, f.status ?? null, f.status ?? null];
    const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM members m ${where}`).get(...params).n;
    const data = ctx.db.prepare(
      `${MEMBER_SELECT} ${where} ORDER BY m.last_name COLLATE NOCASE, m.first_name COLLATE NOCASE LIMIT ? OFFSET ?`)
      .all(...params, f.limit, (f.page - 1) * f.limit);
    return { data, total, page: f.page, limit: f.limit,
      policy: { max_active_loans: setting(ctx.db, 'max_active_loans') } };
  });

  // GET /api/members/:id   (staff, or the member themself)
  router.get('/api/members/:id', ...anyUser, (ctx) => {
    const id = idParam(ctx);
    if (ctx.user.role === 'member' && ctx.user.member_id !== id) {
      throw new ApiError(403, 'FORBIDDEN', 'You can only view your own profile.');
    }
    const member = getMember(ctx.db, id);
    const account = ctx.db.prepare('SELECT username, is_active FROM users WHERE member_id = ?').get(id);
    return { member, account: account ? { ...account } : null,
      policy: { max_active_loans: setting(ctx.db, 'max_active_loans') } };
  });

  // POST /api/members   -> creates the member AND their login account atomically
  router.post('/api/members', ...staff, async (ctx) => {
    const body = validate({
      ...memberFields(true),
      status: T.enum(['active', 'suspended'], { default: 'active', label: 'Status' }),
      password: passwordRule({ nullable: true }),
    }, ctx.body);

    const generated = !body.password;
    const plain = body.password || generateTempPassword();
    const hash = await hashPassword(plain);   // hashed BEFORE the transaction (no awaits inside tx)

    const created = tx(ctx.db, () => {
      const seq = ctx.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'members'").get();
      const memberNo = `LUM-${String((seq ? seq.seq : 0) + 1).padStart(4, '0')}`;
      const r = ctx.db.prepare(
        `INSERT INTO members (member_no, first_name, last_name, email, phone, status)
         VALUES (?, ?, ?, ?, ?, ?)`)
        .run(memberNo, body.first_name, body.last_name, body.email, body.phone ?? null, body.status);
      const id = Number(r.lastInsertRowid);
      ctx.db.prepare(
        "INSERT INTO users (username, password_hash, role, member_id) VALUES (?, ?, 'member', ?)")
        .run(memberNo, hash, id);
      return { id, memberNo };
    });

    ctx.status = 201;
    return {
      member: getMember(ctx.db, created.id),
      account: { username: created.memberNo, temporaryPassword: generated ? plain : undefined },
    };
  });

  // PUT /api/members/:id   (partial update)
  router.put('/api/members/:id', ...staff, (ctx) => {
    const id = idParam(ctx);
    getMember(ctx.db, id);
    const fields = validate(memberFields(false), ctx.body, { partial: true });
    const keys = Object.keys(fields);
    if (!keys.length) throw new ApiError(400, 'VALIDATION_ERROR', 'No changes were provided.');
    ctx.db.prepare(`UPDATE members SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), id);
    return { member: getMember(ctx.db, id) };
  });

  // DELETE /api/members/:id   (admin only; refused if any loan/fine history exists)
  router.delete('/api/members/:id', ...adminOnly, (ctx) => {
    const id = idParam(ctx);
    const member = getMember(ctx.db, id);
    try {
      ctx.db.prepare('DELETE FROM members WHERE id = ?').run(id);   // users row cascades
    } catch (err) {
      if (isSqliteError(err) && /FOREIGN KEY/.test(err.message)) {
        throw new ApiError(409, 'MEMBER_HAS_HISTORY',
          `${member.first_name} ${member.last_name} has loan or fine history and cannot be deleted. Suspend the account instead.`);
      }
      throw err;
    }
    return { deleted: true, id };
  });

  // POST /api/members/:id/reset-password   -> one-time temporary password
  router.post('/api/members/:id/reset-password', ...staff, async (ctx) => {
    const id = idParam(ctx);
    getMember(ctx.db, id);
    const plain = generateTempPassword();
    const hash = await hashPassword(plain);
    const r = ctx.db.prepare('UPDATE users SET password_hash = ? WHERE member_id = ?').run(hash, id);
    if (!r.changes) throw new ApiError(404, 'NOT_FOUND', 'This member has no login account.');
    const account = ctx.db.prepare('SELECT username FROM users WHERE member_id = ?').get(id);
    return { username: account.username, temporaryPassword: plain };
  });
};
