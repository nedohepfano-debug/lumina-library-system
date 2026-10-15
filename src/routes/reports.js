'use strict';
/** FR6 - Dashboard summary and the weekly financial & overdue report (JSON + CSV). */
const { T, validate } = require('../validate');
const { staff } = require('../auth');

function buildWeekly(db, weekStart) {
  const start = weekStart || db.prepare("SELECT date('now','+2 hours','-6 days') AS d").get().d;
  const end = db.prepare("SELECT date(?, '+6 days') AS d").get(start).d;
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const rows = (sql, ...p) => db.prepare(sql).all(...p).map((r) => ({ ...r }));

  const issued = one('SELECT COUNT(*) AS n FROM loans WHERE date(borrowed_at) BETWEEN ? AND ?', start, end).n;
  const returned = one("SELECT COUNT(*) AS n FROM loans WHERE status='returned' AND date(returned_at) BETWEEN ? AND ?", start, end).n;
  const assessed = one('SELECT COUNT(*) AS n, COALESCE(SUM(amount_zar),0) AS zar FROM fines WHERE date(created_at) BETWEEN ? AND ?', start, end);
  const collected = one("SELECT COUNT(*) AS n, COALESCE(SUM(amount_zar),0) AS zar FROM fines WHERE status='paid' AND date(settled_at) BETWEEN ? AND ?", start, end);
  const waived = one("SELECT COUNT(*) AS n, COALESCE(SUM(amount_zar),0) AS zar FROM fines WHERE status='waived' AND date(settled_at) BETWEEN ? AND ?", start, end);
  const outstanding = one("SELECT COUNT(*) AS n, COALESCE(SUM(amount_zar),0) AS zar FROM fines WHERE status='unpaid'");
  const overdue = rows(`SELECT id AS loan_id, member_no, member_name, title, due_date, days_overdue, projected_fine_zar
                          FROM v_loan_details WHERE is_overdue = 1 ORDER BY days_overdue DESC, member_name`);

  const byDay = (sql) => Object.fromEntries(rows(sql, start, end).map((r) => [r.d, r]));
  const issuedBy = byDay('SELECT date(borrowed_at) AS d, COUNT(*) AS n FROM loans WHERE date(borrowed_at) BETWEEN ? AND ? GROUP BY d');
  const returnedBy = byDay("SELECT date(returned_at) AS d, COUNT(*) AS n FROM loans WHERE status='returned' AND date(returned_at) BETWEEN ? AND ? GROUP BY d");
  const assessedBy = byDay('SELECT date(created_at) AS d, SUM(amount_zar) AS zar FROM fines WHERE date(created_at) BETWEEN ? AND ? GROUP BY d');
  const collectedBy = byDay("SELECT date(settled_at) AS d, SUM(amount_zar) AS zar FROM fines WHERE status='paid' AND date(settled_at) BETWEEN ? AND ? GROUP BY d");

  const daily = [];
  for (let i = 0; i < 7; i += 1) {
    const d = one("SELECT date(?, '+' || ? || ' days') AS d, strftime('%w', date(?, '+' || ? || ' days')) AS dow",
      start, i, start, i);
    daily.push({
      date: d.d, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][Number(d.dow)],
      loans_issued: issuedBy[d.d]?.n ?? 0, returns_processed: returnedBy[d.d]?.n ?? 0,
      fines_assessed_zar: assessedBy[d.d]?.zar ?? 0, fines_collected_zar: collectedBy[d.d]?.zar ?? 0,
    });
  }

  const topBooks = rows(`SELECT b.title, b.author, COUNT(*) AS loans
                           FROM loans l JOIN books b ON b.id = l.book_id
                          WHERE date(l.borrowed_at) BETWEEN ? AND ?
                          GROUP BY b.id ORDER BY loans DESC, b.title LIMIT 5`, start, end);

  return {
    period: { start, end },
    totals: {
      loans_issued: issued, returns_processed: returned,
      fines_assessed_count: assessed.n, fines_assessed_zar: assessed.zar,
      fines_collected_count: collected.n, fines_collected_zar: collected.zar,
      fines_waived_zar: waived.zar,
      outstanding_fines_count: outstanding.n, outstanding_fines_zar: outstanding.zar,
      overdue_loans: overdue.length,
      overdue_projected_fines_zar: overdue.reduce((s, r) => s + r.projected_fine_zar, 0),
    },
    daily, overdue, top_books: topBooks,
  };
}

// CSV helpers - values starting with = + - @ are prefixed to defuse spreadsheet formula injection.
const csvCell = (v) => {
  if (typeof v === 'number') return String(v);
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLine = (cells) => cells.map(csvCell).join(',');
const zar = (n) => Number(n).toFixed(2);

function weeklyCsv(db, report) {
  const t = report.totals;
  const now = db.prepare("SELECT datetime('now','+2 hours') AS t").get().t;
  const lines = [
    csvLine(['Lumina Library - Weekly Financial & Overdue Report']),
    csvLine(['Period start', report.period.start]),
    csvLine(['Period end', report.period.end]),
    csvLine(['Generated (SAST)', now]),
    '',
    csvLine(['Metric', 'Value']),
    csvLine(['Loans issued', t.loans_issued]),
    csvLine(['Returns processed', t.returns_processed]),
    csvLine(['Fines assessed (ZAR)', zar(t.fines_assessed_zar)]),
    csvLine(['Fines collected (ZAR)', zar(t.fines_collected_zar)]),
    csvLine(['Fines waived (ZAR)', zar(t.fines_waived_zar)]),
    csvLine(['Outstanding fines, all time (ZAR)', zar(t.outstanding_fines_zar)]),
    '',
    csvLine(['Daily breakdown']),
    csvLine(['Date', 'Issued', 'Returned', 'Fines assessed (ZAR)', 'Fines collected (ZAR)']),
    ...report.daily.map((d) => csvLine([d.date, d.loans_issued, d.returns_processed,
      zar(d.fines_assessed_zar), zar(d.fines_collected_zar)])),
    '',
    csvLine(['Overdue loans (as of today)']),
    csvLine(['Member no', 'Member', 'Title', 'Due date', 'Days overdue', 'Projected fine (ZAR)']),
    ...report.overdue.map((o) => csvLine([o.member_no, o.member_name, o.title, o.due_date,
      o.days_overdue, zar(o.projected_fine_zar)])),
  ];
  return `﻿${lines.join('\r\n')}\r\n`;   // BOM so Excel opens UTF-8 correctly
}

const weekQuery = { week_start: T.date({ label: 'Week start' }) };

module.exports = function register(router) {
  // GET /api/reports/summary  - headline numbers for the staff dashboard
  router.get('/api/reports/summary', ...staff, (ctx) => {
    const one = (sql) => ({ ...ctx.db.prepare(sql).get() });
    return {
      members: one(`SELECT COUNT(*) AS total,
                           SUM(status = 'active') AS active, SUM(status = 'suspended') AS suspended FROM members`),
      books: one('SELECT COUNT(*) AS titles, COALESCE(SUM(total_copies),0) AS copies, COALESCE(SUM(available_copies),0) AS available FROM books'),
      loans: one(`SELECT COALESCE(SUM(status = 'active'),0) AS active, COALESCE(SUM(is_overdue),0) AS overdue,
                         COALESCE(SUM(CASE WHEN date(borrowed_at) = date('now','+2 hours') THEN 1 END),0) AS issued_today
                    FROM v_loan_details`),
      fines: one("SELECT COALESCE(SUM(amount_zar),0) AS unpaid_zar, COUNT(*) AS unpaid_count FROM fines WHERE status = 'unpaid'"),
    };
  });

  // GET /api/reports/weekly?week_start=YYYY-MM-DD   (default: the last 7 days incl. today)
  router.get('/api/reports/weekly', ...staff, (ctx) => {
    const { week_start } = validate(weekQuery, ctx.query);
    return buildWeekly(ctx.db, week_start);
  });

  // GET /api/reports/weekly.csv?week_start=...
  router.get('/api/reports/weekly.csv', ...staff, (ctx) => {
    const { week_start } = validate(weekQuery, ctx.query);
    const report = buildWeekly(ctx.db, week_start);
    ctx.raw = {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="lumina-weekly-report-${report.period.start}.csv"`,
      },
      body: weeklyCsv(ctx.db, report),
    };
  });
};
