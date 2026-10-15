'use strict';
/** FR5 (cont.) - Fines ledger: view, collect payment, waive. */
const { ApiError } = require('../errors');
const { T, validate, idParam, likePattern } = require('../validate');
const { staff, anyUser } = require('../auth');

const FINE_SELECT = `
  SELECT f.id, f.loan_id, f.member_id, m.member_no,
         m.first_name || ' ' || m.last_name AS member_name,
         b.title, l.due_date, l.returned_at,
         f.days_overdue, f.amount_zar, f.status, f.created_at, f.settled_at
    FROM fines f
    JOIN loans   l ON l.id = f.loan_id
    JOIN members m ON m.id = f.member_id
    JOIN books   b ON b.id = l.book_id`;

module.exports = function register(router) {
  // GET /api/fines?status=unpaid|paid|waived|all&member_id=&q=
  router.get('/api/fines', ...anyUser, (ctx) => {
    const f = validate({
      status: T.enum(['unpaid', 'paid', 'waived', 'all'], { default: 'all' }),
      member_id: T.int({ min: 1 }),
      q: T.str({ max: 80 }),
    }, ctx.query);
    const memberId = ctx.user.role === 'member' ? ctx.user.member_id : (f.member_id ?? null);
    const q = f.q ? likePattern(f.q) : null;
    const statusFilter = f.status === 'all' ? null : f.status;
    const where = `WHERE (? IS NULL OR f.status = ?) AND (? IS NULL OR f.member_id = ?)
      AND (? IS NULL OR m.first_name || ' ' || m.last_name LIKE ? ESCAPE '\\'
           OR b.title LIKE ? ESCAPE '\\' OR m.member_no LIKE ? ESCAPE '\\')`;
    const params = [statusFilter, statusFilter, memberId, memberId, q, q, q, q];
    const data = ctx.db.prepare(
      `${FINE_SELECT} ${where} ORDER BY (f.status = 'unpaid') DESC, f.created_at DESC LIMIT 500`).all(...params);
    const totals = ctx.db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN f.status = 'unpaid' THEN f.amount_zar END), 0) AS unpaid_zar,
              COALESCE(SUM(CASE WHEN f.status = 'paid'   THEN f.amount_zar END), 0) AS paid_zar
         FROM fines f JOIN loans l ON l.id = f.loan_id
         JOIN members m ON m.id = f.member_id JOIN books b ON b.id = l.book_id ${where}`).get(...params);
    return { data, totals: { ...totals } };
  });

  // POST /api/fines/:id/settle  { action: 'pay' | 'waive' }   (waive = admin only)
  router.post('/api/fines/:id/settle', ...staff, (ctx) => {
    const id = idParam(ctx);
    const { action } = validate({ action: T.enum(['pay', 'waive'], { required: true, label: 'Action' }) }, ctx.body);
    if (action === 'waive' && ctx.user.role !== 'admin') {
      throw new ApiError(403, 'FORBIDDEN', 'Only an administrator can waive a fine.');
    }
    const fine = ctx.db.prepare('SELECT * FROM fines WHERE id = ?').get(id);
    if (!fine) throw new ApiError(404, 'NOT_FOUND', 'Fine not found.');
    if (fine.status !== 'unpaid') {
      throw new ApiError(409, 'FINE_ALREADY_SETTLED', `This fine is already ${fine.status}.`);
    }
    ctx.db.prepare(
      `UPDATE fines SET status = ?, settled_at = datetime('now', '+2 hours'), settled_by = ?
        WHERE id = ? AND status = 'unpaid'`).run(action === 'pay' ? 'paid' : 'waived', ctx.user.id, id);
    const updated = ctx.db.prepare(`${FINE_SELECT} WHERE f.id = ?`).get(id);
    return { fine: updated,
      message: `Fine of R${Number(updated.amount_zar).toFixed(2)} marked as ${updated.status} for ${updated.member_name}.` };
  });
};
