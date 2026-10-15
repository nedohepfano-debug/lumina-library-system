'use strict';
/**
 * Integration tests: every functional requirement (FR1-FR6) is exercised through the real
 * HTTP server, and the database-level rules are attacked directly with raw SQL to prove
 * they hold even when the API is bypassed.
 *
 *   npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { openDb } = require('../src/db');

let app; let base;
const tokens = {};
const PW = { admin: 'Admin@123', librarian: 'Librarian@123', member: 'Member@123' };

test.before(async () => {
  app = createApp({ db: openDb(':memory:'), secret: 'test-secret', quiet: true, rateLimit: false, demo: true });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  tokens.admin = await login('admin', PW.admin);
  tokens.lib = await login('librarian', PW.librarian);
  tokens.sipho = await login('LUM-0002', PW.member);     // seeded member at the borrowing limit
  tokens.thandi = await login('LUM-0001', PW.member);
});
test.after(() => app.close());

// ------------------------------------------------------------------ helpers
async function call(method, path, { body, token, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text, headers: res.headers };
}
async function login(username, password) {
  const r = await call('POST', '/api/auth/login', { body: { username, password } });
  assert.equal(r.status, 200, `login failed for ${username}: ${r.text}`);
  return r.json.token;
}

let seq = 0;
async function newMember(extra = {}) {
  seq += 1;
  const r = await call('POST', '/api/members', { token: tokens.lib,
    body: { first_name: 'Test', last_name: `User${seq}`, email: `test.user${seq}@example.co.za`, ...extra } });
  assert.equal(r.status, 201, r.text);
  return r.json;
}
async function bookByTitle(title) {
  const r = await call('GET', `/api/books?q=${encodeURIComponent(title)}`, { token: tokens.lib });
  return r.json.data.find((b) => b.title === title);
}
const issue = (memberId, bookId) => call('POST', '/api/loans', { token: tokens.lib, body: { member_id: memberId, book_id: bookId } });

/** Insert a loan that was issued `ago` days ago and is due `dueIn` days from today (negative = overdue). */
function backdatedLoan(memberId, bookId, ago, dueIn) {
  return Number(app.db.prepare(
    `INSERT INTO loans (member_id, book_id, borrowed_at, due_date)
     VALUES (?, ?, datetime('now','+2 hours', ?), date('now','+2 hours', ?))`)
    .run(memberId, bookId, `-${ago} days`, `${dueIn >= 0 ? '+' : ''}${dueIn} days`).lastInsertRowid);
}
const sqlError = (fn) => { try { fn(); } catch (e) { return String(e.message); } return null; };

// =================================================================== FR1 Secure access
test('FR1: protected endpoints reject anonymous requests', async () => {
  for (const p of ['/api/books', '/api/members', '/api/loans', '/api/fines', '/api/reports/summary', '/api/auth/me']) {
    const r = await call('GET', p);
    assert.equal(r.status, 401, p);
    assert.equal(r.json.error.code, 'UNAUTHENTICATED');
  }
});

test('FR1: wrong credentials are refused with one generic message', async () => {
  const a = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'nope-nope1' } });
  const b = await call('POST', '/api/auth/login', { body: { username: 'ghost', password: 'nope-nope1' } });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.json.error.message, b.json.error.message, 'must not reveal which usernames exist');
});

test('FR1: login sets an HttpOnly SameSite=Strict cookie and never exposes the password hash', async () => {
  const r = await call('POST', '/api/auth/login', { body: { username: 'librarian', password: PW.librarian } });
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  assert.ok(!r.text.includes('scrypt$'), 'password hash leaked');
  assert.equal(r.json.user.role, 'librarian');
});

test('FR1: cookie sessions need the anti-CSRF header on state-changing calls', async () => {
  const r = await call('POST', '/api/auth/login', { body: { username: 'librarian', password: PW.librarian } });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const blocked = await call('POST', '/api/loans', { headers: { Cookie: cookie }, body: { member_id: 1, book_id: 1 } });
  assert.equal(blocked.status, 403); assert.equal(blocked.json.error.code, 'CSRF_REJECTED');
  const allowed = await call('GET', '/api/auth/me', { headers: { Cookie: cookie } });
  assert.equal(allowed.status, 200);
});

test('FR1: tampered and garbage tokens are rejected', async () => {
  const bad = tokens.admin.slice(0, -3) + 'abc';
  assert.equal((await call('GET', '/api/auth/me', { token: bad })).status, 401);
  assert.equal((await call('GET', '/api/auth/me', { token: 'a.b.c' })).status, 401);
  // alg=none forgery
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":1,"role":"admin","exp":9999999999}').toString('base64url')}.`;
  assert.equal((await call('GET', '/api/auth/me', { token: none })).status, 401);
});

test('FR1: role separation - members cannot reach staff endpoints', async () => {
  for (const [m, p] of [['GET', '/api/members'], ['GET', '/api/reports/summary'], ['GET', '/api/reports/weekly'], ['POST', '/api/loans'], ['POST', '/api/books']]) {
    const r = await call(m, p, { token: tokens.sipho, body: m === 'POST' ? {} : undefined });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
});

test('FR1: members only ever see their own loans, fines and profile', async () => {
  const mine = await call('GET', '/api/loans?status=all&member_id=1', { token: tokens.sipho });   // tries to peek at member 1
  assert.equal(mine.status, 200);
  assert.ok(mine.json.data.length > 0);
  assert.ok(mine.json.data.every((l) => l.member_no === 'LUM-0002'), 'leaked another member\'s loans');
  const fines = await call('GET', '/api/fines', { token: tokens.sipho });
  assert.ok(fines.json.data.every((f) => f.member_no === 'LUM-0002'));
  assert.equal((await call('GET', '/api/members/1', { token: tokens.sipho })).status, 403);
});

test('FR1: only admins may delete or waive', async () => {
  const m = await newMember();
  assert.equal((await call('DELETE', `/api/members/${m.member.id}`, { token: tokens.lib })).status, 403);
  assert.equal((await call('DELETE', `/api/members/${m.member.id}`, { token: tokens.admin })).status, 200);
});

test('FR1: changing a password invalidates every older token', async () => {
  const m = await newMember({ password: 'Initial1pass' });
  const old = await login(m.account.username, 'Initial1pass');
  const ch = await call('POST', '/api/auth/change-password', { token: old, body: { current_password: 'Initial1pass', new_password: 'Changed2pass' } });
  assert.equal(ch.status, 200);
  assert.equal((await call('GET', '/api/auth/me', { token: old })).status, 401, 'old token must die');
  assert.equal((await call('GET', '/api/auth/me', { token: ch.json.token })).status, 200);
  const weak = await call('POST', '/api/auth/change-password', { token: ch.json.token, body: { current_password: 'Changed2pass', new_password: 'short' } });
  assert.equal(weak.status, 400);
});

test('FR1: brute-force protection returns 429 after repeated failures', async () => {
  const strict = createApp({ db: openDb(':memory:'), secret: 's', quiet: true, rateLimit: true, autoSeed: false });
  await new Promise((r) => strict.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${strict.server.address().port}/api/auth/login`;
  let last;
  for (let i = 0; i < 11; i += 1) {
    last = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong-pass1' }) });
  }
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
  await strict.close();
});

// =================================================================== input validation & error handling
test('Validation: bad input yields 400 with per-field details, never a 500', async () => {
  const r = await call('POST', '/api/members', { token: tokens.lib, body: { first_name: '', last_name: 'x', email: 'not-an-email', phone: 'abc' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'VALIDATION_ERROR');
  const fields = r.json.error.details.map((d) => d.field).sort();
  assert.deepEqual(fields, ['email', 'first_name', 'phone']);
});

test('Validation: malformed JSON, wrong content type, oversized body, unknown route and wrong method', async () => {
  const raw = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(raw.status, 400);
  const form = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'a=b' });
  assert.equal(form.status, 415);
  const big = await call('POST', '/api/auth/login', { body: { username: 'a'.repeat(30000), password: 'x' } });
  assert.equal(big.status, 413);
  assert.equal((await call('GET', '/api/nope', { token: tokens.admin })).status, 404);
  assert.equal((await call('PATCH', '/api/books', { token: tokens.admin })).status, 405);
});

test('Validation: SQL-injection style input is treated as plain text', async () => {
  const r = await call('GET', `/api/books?q=${encodeURIComponent("'; DROP TABLE books; --")}`, { token: tokens.lib });
  assert.equal(r.status, 200); assert.equal(r.json.total, 0);
  assert.ok((await call('GET', '/api/books', { token: tokens.lib })).json.total > 0, 'books table must still exist');
  const wild = await call('GET', '/api/books?q=%25', { token: tokens.lib });   // a literal "%" is not a wildcard
  assert.equal(wild.json.total, 0);
});

test('Validation: mass assignment is blocked (unknown fields are dropped)', async () => {
  const m = await newMember();
  const r = await call('PUT', `/api/members/${m.member.id}`, { token: tokens.lib, body: { last_name: 'Renamed', id: 999, member_no: 'HACK-1' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.member.id, m.member.id);
  assert.notEqual(r.json.member.member_no, 'HACK-1');
});

test('Security headers are present and static path traversal is refused', async () => {
  const r = await fetch(`${base}/`);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}/..%2f..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/data/.jwt_secret`)).status, 404);
});

// =================================================================== FR2 Member CRUD
test('FR2: create -> read -> update -> delete a member, with an auto-generated login', async () => {
  const c = await newMember({ phone: '082 123 4567' });
  assert.match(c.member.member_no, /^LUM-\d{4}$/);
  assert.equal(c.account.username, c.member.member_no);
  assert.ok(c.account.temporaryPassword.length >= 8);
  await login(c.account.username, c.account.temporaryPassword);       // the generated password really works

  const u = await call('PUT', `/api/members/${c.member.id}`, { token: tokens.lib, body: { status: 'suspended' } });
  assert.equal(u.json.member.status, 'suspended');
  const g = await call('GET', `/api/members/${c.member.id}`, { token: tokens.lib });
  assert.equal(g.json.member.last_name, c.member.last_name);

  assert.equal((await call('DELETE', `/api/members/${c.member.id}`, { token: tokens.admin })).status, 200);
  assert.equal((await call('GET', `/api/members/${c.member.id}`, { token: tokens.lib })).status, 404);
  assert.equal((await call('POST', '/api/auth/login', { body: { username: c.account.username, password: c.account.temporaryPassword } })).status, 401,
    'login account must cascade-delete with the member');
});

test('FR2: duplicate email is a friendly 409; search filters the registry', async () => {
  const a = await newMember();
  const dup = await call('POST', '/api/members', { token: tokens.lib, body: { first_name: 'X', last_name: 'Y', email: a.member.email.toUpperCase() } });
  assert.equal(dup.status, 409); assert.equal(dup.json.error.code, 'DUPLICATE_VALUE');
  const s = await call('GET', '/api/members?q=Mkhize', { token: tokens.lib });
  assert.ok(s.json.data.length >= 1 && s.json.data.every((m) => /mkhize/i.test(m.last_name + m.first_name)));
  assert.ok((await call('GET', '/api/members?status=suspended', { token: tokens.lib })).json.data.every((m) => m.status === 'suspended'));
});

test('FR2: a member with loan history cannot be deleted (history is preserved)', async () => {
  const r = await call('DELETE', '/api/members/1', { token: tokens.admin });   // Thandi has loans
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'MEMBER_HAS_HISTORY');
});

// =================================================================== FR3 Book CRUD & search
test('FR3: create, search, edit and delete a book', async () => {
  const c = await call('POST', '/api/books', { token: tokens.lib, body: { isbn: '978-0-14-143951-8', title: 'Test Driven Tales', author: 'A. Tester', category: 'Fiction', publication_year: 2020, total_copies: 2 } });
  assert.equal(c.status, 201);
  assert.equal(c.json.book.isbn, '9780141439518');            // normalised
  assert.equal(c.json.book.available_copies, 2);
  const id = c.json.book.id;

  const byAuthor = await call('GET', '/api/books?q=tester', { token: tokens.sipho });   // members can search too
  assert.ok(byAuthor.json.data.some((b) => b.id === id));
  const byIsbn = await call('GET', '/api/books?q=9780141439518', { token: tokens.lib });
  assert.equal(byIsbn.json.total, 1);

  const e = await call('PUT', `/api/books/${id}`, { token: tokens.lib, body: { title: 'Test Driven Tales (2nd ed.)', total_copies: 5 } });
  assert.equal(e.json.book.available_copies, 5);
  assert.equal((await call('DELETE', `/api/books/${id}`, { token: tokens.admin })).status, 200);
});

test('FR3: ISBN rules, duplicate ISBN and the available-only filter', async () => {
  const bad = await call('POST', '/api/books', { token: tokens.lib, body: { isbn: '12345', title: 'T', author: 'A' } });
  assert.equal(bad.status, 400);
  const first = await bookByTitle('The Hobbit');
  const dup = await call('POST', '/api/books', { token: tokens.lib, body: { isbn: first.isbn, title: 'Clone', author: 'A' } });
  assert.equal(dup.status, 409);
  const avail = await call('GET', '/api/books?available=true&limit=200', { token: tokens.lib });
  assert.ok(avail.json.data.every((b) => b.available_copies > 0));
  assert.ok(!avail.json.data.some((b) => b.title === 'Mhudi'), 'Mhudi has no copy in');
});

test('FR3: cannot cut total copies below the number on loan; cannot delete a book with history', async () => {
  const hobbit = await bookByTitle('The Hobbit');       // 1 on loan in the seed data
  const r = await call('PUT', `/api/books/${hobbit.id}`, { token: tokens.lib, body: { total_copies: 0 } });
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'COPIES_IN_USE');
  const d = await call('DELETE', `/api/books/${hobbit.id}`, { token: tokens.admin });
  assert.equal(d.status, 409); assert.equal(d.json.error.code, 'BOOK_HAS_HISTORY');
});

// =================================================================== FR4 Loans & limit enforcement
test('FR4: a member can borrow up to 3 books; the 4th is refused with a clear message', async () => {
  const { member } = await newMember();
  const titles = ['Spud', 'Clean Code', 'Disgrace', 'The Gruffalo'];
  for (let i = 0; i < 3; i += 1) {
    const r = await issue(member.id, (await bookByTitle(titles[i])).id);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.active_loans, i + 1);
    assert.match(r.json.loan.due_date, /^\d{4}-\d{2}-\d{2}$/);
  }
  const fourth = await issue(member.id, (await bookByTitle(titles[3])).id);
  assert.equal(fourth.status, 409);
  assert.equal(fourth.json.error.code, 'BORROW_LIMIT');
  assert.match(fourth.json.error.message, /3 of 3/);
});

test('FR4: stock decrements on issue; out-of-stock, duplicate-title and suspended rules', async () => {
  const { member } = await newMember();
  const book = await bookByTitle('The Gruffalo');
  const before = book.available_copies;
  assert.equal((await issue(member.id, book.id)).status, 201);
  assert.equal((await bookByTitle('The Gruffalo')).available_copies, before - 1);
  const again = await issue(member.id, book.id);
  assert.equal(again.status, 409); assert.equal(again.json.error.code, 'ALREADY_BORROWED');

  const mhudi = await bookByTitle('Mhudi');
  const out = await issue(member.id, mhudi.id);
  assert.equal(out.status, 409); assert.equal(out.json.error.code, 'OUT_OF_STOCK');

  const sus = await call('GET', '/api/members?status=suspended', { token: tokens.lib });
  const r = await issue(sus.json.data[0].id, book.id);
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'MEMBER_SUSPENDED');
});

test('FR4: the 3-book limit is enforced by the DATABASE itself (API bypassed with raw SQL)', async () => {
  const sipho = app.db.prepare("SELECT id FROM members WHERE member_no = 'LUM-0002'").get().id;
  const book = (await bookByTitle('Clean Code')).id;
  const err = sqlError(() => app.db.prepare("INSERT INTO loans (member_id, book_id, due_date) VALUES (?, ?, date('now','+14 days'))").run(sipho, book));
  assert.equal(err, 'BORROW_LIMIT');
});

test('FR4: the borrowing limit is a policy setting, not a hard-coded constant', async () => {
  app.db.prepare("UPDATE settings SET value = 1 WHERE key = 'max_active_loans'").run();
  try {
    const { member } = await newMember();
    assert.equal((await issue(member.id, (await bookByTitle('Clean Code')).id)).status, 201);
    assert.equal((await issue(member.id, (await bookByTitle('Spud')).id)).json.error.code, 'BORROW_LIMIT');
  } finally { app.db.prepare("UPDATE settings SET value = 3 WHERE key = 'max_active_loans'").run(); }
});

// =================================================================== FR5 Returns & ZAR fines
test('FR5: an on-time return restocks the book and charges no fine', async () => {
  const { member } = await newMember();
  const book = await bookByTitle('Atomic Habits');
  const loan = (await issue(member.id, book.id)).json.loan;
  const r = await call('POST', `/api/loans/${loan.id}/return`, { token: tokens.lib });
  assert.equal(r.status, 200); assert.equal(r.json.fine, null);
  assert.equal(r.json.loan.status, 'returned');
  assert.equal((await bookByTitle('Atomic Habits')).available_copies, book.available_copies);
  const again = await call('POST', `/api/loans/${loan.id}/return`, { token: tokens.lib });
  assert.equal(again.status, 409); assert.equal(again.json.error.code, 'LOAN_ALREADY_RETURNED');
});

test('FR5: a late return creates a fine of days x R2.00 automatically', async () => {
  const { member } = await newMember();
  const book = await bookByTitle('Born a Crime');
  const id = backdatedLoan(member.id, book.id, 20, -6);               // due 6 days ago
  const r = await call('POST', `/api/loans/${id}/return`, { token: tokens.lib });
  assert.equal(r.status, 200);
  assert.equal(r.json.fine.days_overdue, 6);
  assert.equal(r.json.fine.amount_zar, 12);
  assert.match(r.json.message, /R12\.00/);
});

test('FR5: fines are capped at R100.00 per loan', async () => {
  const { member } = await newMember();
  const id = backdatedLoan(member.id, (await bookByTitle('Ways of Dying')).id, 200, -150);
  const r = await call('POST', `/api/loans/${id}/return`, { token: tokens.lib });
  assert.equal(r.json.fine.days_overdue, 150);
  assert.equal(r.json.fine.amount_zar, 100);
  assert.match(r.json.message, /capped/);
});

test('FR5: overdue loans show a live projected fine before they are returned', async () => {
  const od = await call('GET', '/api/loans?status=overdue', { token: tokens.lib });
  assert.ok(od.json.data.length >= 1);
  for (const l of od.json.data) {
    assert.equal(l.is_overdue, 1);
    assert.equal(l.projected_fine_zar, Math.min(l.days_overdue * 2, 100));
  }
});

test('FR5: fines can be paid by staff; waiving is admin-only; a fine settles only once', async () => {
  const m2 = await newMember();
  const loan2 = backdatedLoan(m2.member.id, (await bookByTitle('Spud')).id, 30, -5);
  await call('POST', `/api/loans/${loan2}/return`, { token: tokens.lib });
  const fine = (await call('GET', `/api/fines?status=unpaid&member_id=${m2.member.id}`, { token: tokens.lib })).json.data[0];
  assert.equal(fine.amount_zar, 10);

  const forbidden = await call('POST', `/api/fines/${fine.id}/settle`, { token: tokens.lib, body: { action: 'waive' } });
  assert.equal(forbidden.status, 403);
  const paid = await call('POST', `/api/fines/${fine.id}/settle`, { token: tokens.lib, body: { action: 'pay' } });
  assert.equal(paid.status, 200); assert.equal(paid.json.fine.status, 'paid');
  const twice = await call('POST', `/api/fines/${fine.id}/settle`, { token: tokens.admin, body: { action: 'waive' } });
  assert.equal(twice.status, 409);
});

test('Database integrity: immutable loans, no re-opening, CHECK and FOREIGN KEY constraints', async () => {
  const loanId = app.db.prepare("SELECT id FROM loans WHERE status = 'returned' LIMIT 1").get().id;
  assert.equal(sqlError(() => app.db.prepare("UPDATE loans SET due_date = '2099-01-01' WHERE id = ?").run(loanId)), 'LOAN_IMMUTABLE');
  assert.equal(sqlError(() => app.db.prepare("UPDATE loans SET status = 'active', returned_at = NULL WHERE id = ?").run(loanId)), 'LOAN_ALREADY_RETURNED');
  assert.match(sqlError(() => app.db.prepare('UPDATE books SET available_copies = total_copies + 1 WHERE id = 1').run()), /CHECK constraint failed/);
  assert.match(sqlError(() => app.db.prepare('UPDATE books SET available_copies = -1 WHERE id = 1').run()), /CHECK constraint failed/);
  assert.match(sqlError(() => app.db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('rogue', 'x', 'member')").run()), /CHECK constraint failed/, 'a member account must be linked to a member');
  assert.match(sqlError(() => app.db.prepare("INSERT INTO fines (loan_id, member_id, days_overdue, amount_zar) VALUES (99999, 1, 1, 2)").run()), /FOREIGN KEY/);
  assert.match(sqlError(() => app.db.prepare('DELETE FROM books WHERE id IN (SELECT book_id FROM loans LIMIT 1)').run()), /FOREIGN KEY/, 'RESTRICT must protect loan history');
});

// =================================================================== FR6 Reporting
test('FR6: weekly report returns reconciled totals, daily rows and the overdue list', async () => {
  const r = await call('GET', '/api/reports/weekly', { token: tokens.lib });
  assert.equal(r.status, 200);
  assert.equal(r.json.daily.length, 7);
  const sum = (k) => r.json.daily.reduce((s, d) => s + d[k], 0);
  assert.equal(sum('loans_issued'), r.json.totals.loans_issued);
  assert.equal(sum('returns_processed'), r.json.totals.returns_processed);
  assert.ok(Math.abs(sum('fines_assessed_zar') - r.json.totals.fines_assessed_zar) < 0.001);
  assert.equal(r.json.overdue.length, r.json.totals.overdue_loans);
  const summary = await call('GET', '/api/reports/summary', { token: tokens.lib });
  assert.equal(summary.json.loans.overdue, r.json.totals.overdue_loans);
});

test('FR6: CSV export is downloadable, Excel-friendly and safe from formula injection', async () => {
  const r = await call('GET', '/api/reports/weekly.csv', { token: tokens.lib });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="lumina-weekly-report-\d{4}-\d{2}-\d{2}\.csv"/);
  const bytes = new Uint8Array(await (await fetch(`${base}/api/reports/weekly.csv`, { headers: { Authorization: `Bearer ${tokens.lib}` } })).arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'UTF-8 BOM so Excel opens the file correctly');
  assert.match(r.text, /Fines collected \(ZAR\)/);
  // a hostile member name must be neutralised
  const { member } = await newMember({ first_name: '=HYPERLINK("http://evil")' });
  backdatedLoan(member.id, (await bookByTitle("Harry Potter and the Philosopher's Stone")).id, 40, -4);
  const csv = (await call('GET', '/api/reports/weekly.csv', { token: tokens.lib })).text;
  assert.ok(csv.includes(`'=HYPERLINK`), 'formula must be prefixed with an apostrophe');
  assert.ok(!/(^|,)=HYPERLINK/m.test(csv));
});

test('FR6: a specific week can be requested; bad dates are rejected; members cannot read reports', async () => {
  const past = await call('GET', '/api/reports/weekly?week_start=2020-01-06', { token: tokens.lib });
  assert.equal(past.json.period.start, '2020-01-06'); assert.equal(past.json.period.end, '2020-01-12');
  assert.equal(past.json.totals.loans_issued, 0);
  assert.equal((await call('GET', '/api/reports/weekly?week_start=2020-13-45', { token: tokens.lib })).status, 400);
  assert.equal((await call('GET', '/api/reports/weekly', { token: tokens.thandi })).status, 403);
});
