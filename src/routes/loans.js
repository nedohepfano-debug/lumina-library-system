'use strict';
/**
 * FR4 - Loan transactions & limit enforcement
 * FR5 - Return processing & automated ZAR fines
 *
 * The API validates input and produces friendly messages, but the *rules*
 * (3-book limit, suspension, stock, duplicate loans, fine maths) are enforced by
 * triggers/constraints in schema.sql, so they hold no matter which client calls us.
 */
const { ApiError, isSqliteError } = require('../errors');
const { T, validate, idParam, likePattern } = require('../validate');
const { staff, anyUser } = require('../auth');
const { tx, setting } = require('../db');

const LOAN_COLS = `id, member_id, member_no, member_name, book_id, title, author, isbn,
  borrowed_at, due_date, returned_at, status, is_overdue, days_overdue, projected_fine_zar`;

const loanById = (db, id) => db.prepare(`SELECT ${LOAN_COLS} FROM v_loan_details WHERE id = ?`).get(id);
const money = (n) => `R${Number(n).toFixed(2)}`;

module.exports = function register(router) {
  // GET /api/loans?status=active|overdue|returned|all&member_id=&q=
  router.get('/api/loans', ...anyUser, (ctx) => {
    const f = validate({
      status: T.enum(['active', 'overdue', 'returned', 'all'], { default: 'active' }),
      member_id: T.int({ min: 1 }),
      q: T.str({ max: 80 }),
      page: T.int({ min: 1, default: 1 }),
      limit: T.int({ min: 1, max: 200, default: 100 }),
    }, ctx.query);

    // Members are always scoped to their own loans, whatever they ask for.
    const memberId = ctx.user.role === 'member' ? ctx.user.member_id : (f.member_id ?? null);
    const q = f.q ? likePattern(f.q) : null;
    const statusSql = { active: "status = 'active'", overdue: 'is_overdue = 1',
      returned: "status = 'returned'", all: '1 = 1' }[f.status];
    const where = `WHERE ${statusSql} AND (? IS NULL OR member_id = ?)
      AND (? IS NULL OR member_name LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
           OR member_no LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\')`;
    const params = [memberId, memberId, q, q, q, q, q];
    const order = f.status === 'returned' ? 'returned_at DESC' : 'due_date ASC, id ASC';

    const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM v_loan_details ${where}`).get(...params).n;
    const data = ctx.db.prepare(
      `SELECT ${LOAN_COLS} FROM v_loan_details ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, f.limit, (f.page - 1) * f.limit);
    return { data, total, page: f.page, limit: f.limit,
      policy: { max_active_loans: setting(ctx.db, 'max_active_loans'),
        loan_period_days: setting(ctx.db, 'loan_period_days'),
        fine_per_day_zar: setting(ctx.db, 'fine_per_day_zar'),
        fine_cap_zar: setting(ctx.db, 'fine_cap_zar') } };
  });

  // POST /api/loans  { member_id, book_id }   (FR4)
  router.post('/api/loans', ...staff, (ctx) => {
    const body = validate({
      member_id: T.int({ required: true, min: 1, label: 'Member' }),
      book_id: T.int({ required: true, min: 1, label: 'Book' }),
    }, ctx.body);

    const member = ctx.db.prepare('SELECT * FROM members WHERE id = ?').get(body.member_id);
    if (!member) throw new ApiError(404, 'NOT_FOUND', 'Member not found.');
    const book = ctx.db.prepare('SELECT * FROM books WHERE id = ?').get(body.book_id);
    if (!book) throw new ApiError(404, 'NOT_FOUND', 'Book not found.');
    const max = setting(ctx.db, 'max_active_loans');
    const name = `${member.first_name} ${member.last_name}`;

    let loanId;
    try {
      const r = ctx.db.prepare(
        `INSERT INTO loans (member_id, book_id, issued_by, due_date)
         VALUES (?, ?, ?, date('now', '+2 hours',
                 '+' || CAST((SELECT value FROM settings WHERE key = 'loan_period_days') AS INTEGER) || ' days'))`)
        .run(member.id, book.id, ctx.user.id);
      loanId = Number(r.lastInsertRowid);
    } catch (err) {
      if (!isSqliteError(err)) throw err;
      const active = ctx.db.prepare(
        "SELECT COUNT(*) AS n FROM loans WHERE member_id = ? AND status = 'active'").get(member.id).n;
      if (err.message === 'BORROW_LIMIT') {
        throw new ApiError(409, 'BORROW_LIMIT',
          `Borrowing limit reached: ${name} already holds ${active} of ${max} books. A book must be returned before another can be issued.`,
          [{ active_loans: active, max_active_loans: max }]);
      }
      if (err.message === 'MEMBER_SUSPENDED') {
        throw new ApiError(409, 'MEMBER_SUSPENDED',
          `${name}'s membership is suspended. Reactivate the member before issuing books.`);
      }
      if (err.message === 'OUT_OF_STOCK') {
        throw new ApiError(409, 'OUT_OF_STOCK',
          `"${book.title}" has no copies available right now (0 of ${book.total_copies} in).`);
      }
      if (err.message.startsWith('UNIQUE constraint failed: loans')) {
        throw new ApiError(409, 'ALREADY_BORROWED', `${name} already has "${book.title}" on loan.`);
      }
      throw err;
    }

    const loan = loanById(ctx.db, loanId);
    const active = ctx.db.prepare(
      "SELECT COUNT(*) AS n FROM loans WHERE member_id = ? AND status = 'active'").get(member.id).n;
    ctx.status = 201;
    return { loan, active_loans: active, max_active_loans: max,
      message: `"${book.title}" issued to ${name}. Due ${loan.due_date}. (${active} of ${max} books on loan)` };
  });

  // POST /api/loans/:id/return   (FR5)
  router.post('/api/loans/:id/return', ...staff, (ctx) => {
    const id = idParam(ctx);
    const rate = setting(ctx.db, 'fine_per_day_zar');
    const cap = setting(ctx.db, 'fine_cap_zar');

    const fine = tx(ctx.db, () => {
      const loan = ctx.db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
      if (!loan) throw new ApiError(404, 'NOT_FOUND', 'Loan not found.');
      if (loan.status === 'returned') {
        throw new ApiError(409, 'LOAN_ALREADY_RETURNED', 'This loan has already been returned.');
      }
      // Restocking and fine assessment happen in trigger trg_loans_return.
      ctx.db.prepare(
        `UPDATE loans SET status = 'returned', returned_at = datetime('now', '+2 hours')
          WHERE id = ? AND status = 'active'`).run(id);
      return ctx.db.prepare('SELECT * FROM fines WHERE loan_id = ?').get(id) || null;
    });

    const loan = loanById(ctx.db, id);
    let message = `"${loan.title}" returned by ${loan.member_name}. On time - no fine due.`;
    if (fine) {
      const capped = fine.amount_zar >= cap && fine.days_overdue * rate > cap;
      message = `"${loan.title}" returned ${fine.days_overdue} day${fine.days_overdue === 1 ? '' : 's'} late. `
        + `Fine of ${money(fine.amount_zar)} recorded (${fine.days_overdue} × ${money(rate)}${capped ? `, capped at ${money(cap)}` : ''}).`;
    }
    return { loan, fine: fine ? { ...fine } : null, message };
  });
};
