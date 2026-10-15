'use strict';
/**
 * Demo data for the Lumina Library (Makhanda community).
 *   npm run seed    -> seeds only if the database is empty
 *   npm run reset   -> deletes the database file and re-seeds
 * Dates are relative to "today" so overdue/fine scenarios always work in a live demo.
 */
const fs = require('node:fs');
const { openDb, tx, DEFAULT_DB } = require('./db');
const { hashPasswordSync } = require('./security');

const DEMO_PASSWORDS = { admin: 'Admin@123', librarian: 'Librarian@123', member: 'Member@123' };

function isbn13(nineDigits) {
  const d = ('978' + nineDigits).split('').map(Number);
  const sum = d.reduce((s, n, i) => s + n * (i % 2 === 0 ? 1 : 3), 0);
  return d.join('') + ((10 - (sum % 10)) % 10);
}

const MEMBERS = [
  ['Thandi', 'Mkhize', 'thandi.mkhize@example.co.za', '0821234567', 'active'],
  ['Sipho', 'Ndlovu', 'sipho.ndlovu@example.co.za', '0834567890', 'active'],
  ['Lerato', 'Dlamini', 'lerato.dlamini@example.co.za', '0845551234', 'active'],
  ['Anele', 'Jacobs', 'anele.jacobs@example.co.za', '0719876543', 'active'],
  ['Johan', 'van Wyk', 'johan.vanwyk@example.co.za', '0728765432', 'active'],
  ['Zinhle', 'Qwabe', 'zinhle.qwabe@example.co.za', '0763456789', 'suspended'],
];

// [title, author, category, year, copies]
const BOOKS = [
  ['Long Walk to Freedom', 'Nelson Mandela', 'Biography', 1994, 3],
  ['Born a Crime', 'Trevor Noah', 'Biography', 2016, 2],
  ['Cry, the Beloved Country', 'Alan Paton', 'Fiction', 1948, 3],
  ['Mhudi', 'Sol Plaatje', 'Fiction', 1930, 1],
  ['Disgrace', 'J.M. Coetzee', 'Fiction', 1999, 2],
  ["July's People", 'Nadine Gordimer', 'Fiction', 1981, 2],
  ['Ways of Dying', 'Zakes Mda', 'Fiction', 1995, 1],
  ['Country of My Skull', 'Antjie Krog', 'Non-Fiction', 1998, 2],
  ['Spud', 'John van de Ruit', 'Fiction', 2005, 2],
  ['A Brief History of Time', 'Stephen Hawking', 'Science', 1988, 2],
  ['The Gene: An Intimate History', 'Siddhartha Mukherjee', 'Science', 2016, 1],
  ['Introduction to Algorithms', 'Thomas H. Cormen', 'Computer Science', 2009, 2],
  ['Clean Code', 'Robert C. Martin', 'Computer Science', 2008, 2],
  ['The Hobbit', 'J.R.R. Tolkien', 'Fantasy', 1937, 3],
  ["Harry Potter and the Philosopher's Stone", 'J.K. Rowling', 'Fantasy', 1997, 4],
  ['Atomic Habits', 'James Clear', 'Self-Help', 2018, 2],
  ['Rich Dad Poor Dad', 'Robert Kiyosaki', 'Finance', 1997, 2],
  ['The Gruffalo', 'Julia Donaldson', 'Children', 1999, 2],
];

function seed(db, log = () => {}) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (existing > 0) { log('Database already contains data - seed skipped.'); return false; }

  tx(db, () => {
    const addUser = db.prepare(
      'INSERT INTO users (username, password_hash, role, member_id) VALUES (?, ?, ?, ?)');
    addUser.run('admin', hashPasswordSync(DEMO_PASSWORDS.admin), 'admin', null);
    const librarianId = Number(addUser.run('librarian',
      hashPasswordSync(DEMO_PASSWORDS.librarian), 'librarian', null).lastInsertRowid);

    const memberHash = hashPasswordSync(DEMO_PASSWORDS.member);
    const addMember = db.prepare(
      'INSERT INTO members (member_no, first_name, last_name, email, phone, status) VALUES (?,?,?,?,?,?)');
    MEMBERS.forEach(([f, l, email, phone, status], i) => {
      const no = `LUM-${String(i + 1).padStart(4, '0')}`;
      const id = Number(addMember.run(no, f, l, email, phone, status).lastInsertRowid);
      addUser.run(no, memberHash, 'member', id);
    });

    const addBook = db.prepare(
      `INSERT INTO books (isbn, title, author, category, publication_year, total_copies, available_copies)
       VALUES (?,?,?,?,?,?,?)`);
    BOOKS.forEach(([title, author, cat, year, copies], i) => {
      addBook.run(isbn13(String(100000000 + i * 7919).slice(0, 9)), title, author, cat, year, copies, copies);
    });

    const bookId = (t) => db.prepare('SELECT id FROM books WHERE title = ?').get(t).id;
    const memberId = (no) => db.prepare('SELECT id FROM members WHERE member_no = ?').get(no).id;

    // Issue a loan N days ago (due 14 days later); optionally return it R days ago.
    // Returns go through the real trigger, so fines are produced natively.
    function loan(no, title, borrowedDaysAgo, returnedDaysAgo = null) {
      const res = db.prepare(
        `INSERT INTO loans (member_id, book_id, issued_by, borrowed_at, due_date)
         VALUES (?, ?, ?, datetime('now','+2 hours', ?), date('now','+2 hours', ?, '+14 days'))`)
        .run(memberId(no), bookId(title), librarianId,
          `-${borrowedDaysAgo} days`, `-${borrowedDaysAgo} days`);
      const id = Number(res.lastInsertRowid);
      if (returnedDaysAgo !== null) {
        db.prepare(`UPDATE loans SET status='returned',
                    returned_at = datetime('now','+2 hours', ?) WHERE id = ?`)
          .run(`-${returnedDaysAgo} days`, id);
        db.prepare(`UPDATE fines SET created_at =
                    (SELECT returned_at FROM loans WHERE id = ?) WHERE loan_id = ?`).run(id, id);
      }
      return id;
    }

    // ---- history (returned) ----
    loan('LUM-0001', 'Long Walk to Freedom', 60, 50);           // on time
    const lateLoan = loan('LUM-0003', 'Cry, the Beloved Country', 20, 2); // 4 days late -> R8.00
    loan('LUM-0004', "July's People", 12, 3);                    // on time
    loan('LUM-0002', 'Atomic Habits', 30, 1);                    // 15 days late -> R30.00 (unpaid)
    db.prepare(`UPDATE fines SET status='paid',
                settled_at = datetime('now','+2 hours','-1 days'), settled_by = ?
                WHERE loan_id = ?`).run(librarianId, lateLoan);

    // ---- currently active ----
    loan('LUM-0001', 'Born a Crime', 25);                        // 11 days overdue
    loan('LUM-0001', 'A Brief History of Time', 3);
    loan('LUM-0002', 'Disgrace', 5);                             // Sipho: at the 3-book limit
    loan('LUM-0002', 'Country of My Skull', 4);
    loan('LUM-0002', 'Introduction to Algorithms', 16);          // 2 days overdue
    loan('LUM-0004', 'Mhudi', 1);                                // last copy -> out of stock
    loan('LUM-0004', 'The Hobbit', 1);
  });

  log('Seeded: 2 staff, 6 members, 18 books, sample loans & fines.');
  return true;
}

module.exports = { seed, DEMO_PASSWORDS };

if (require.main === module) {
  if (process.argv.includes('--reset')) {
    const file = process.env.DB_PATH || DEFAULT_DB;
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    console.log('Existing database removed.');
  }
  const db = openDb();
  seed(db, console.log);
  db.close();
}
