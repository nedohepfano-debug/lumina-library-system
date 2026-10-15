-- =====================================================================
-- Lumina Library Resource & Member Management System  (SDP152)
-- SQLite schema: relational integrity, CHECK constraints and triggers.
--
-- Business rules enforced INSIDE the database (not only in the API):
--   BR1  A member may hold at most `max_active_loans` (3) books at once.
--   BR2  A suspended member cannot borrow.
--   BR3  A book with no available copies cannot be lent.
--   BR4  A member cannot hold two active loans of the same title.
--   BR5  Stock (available_copies) is adjusted atomically on issue/return.
--   BR6  Returning a late book automatically creates a ZAR fine:
--        days_late x fine_per_day_zar, capped at fine_cap_zar.
--
-- All timestamps are stored as South African Standard Time (UTC+2, no DST):
-- datetime('now','+2 hours').
-- =====================================================================
PRAGMA foreign_keys = ON;

-- ---------- Configurable policy values (single source of truth) ------
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       REAL NOT NULL CHECK (value >= 0),
  description TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('max_active_loans', 3,   'Maximum books a member may hold at once'),
  ('loan_period_days', 14,  'Days from issue until a loan is due'),
  ('fine_per_day_zar', 2.0, 'Overdue fine per day (South African Rand)'),
  ('fine_cap_zar',     100, 'Maximum fine charged per loan (ZAR)');

-- ---------- Members (FR2) -------------------------------------------
CREATE TABLE IF NOT EXISTS members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  member_no   TEXT NOT NULL UNIQUE,
  first_name  TEXT NOT NULL CHECK (length(trim(first_name)) BETWEEN 1 AND 60),
  last_name   TEXT NOT NULL CHECK (length(trim(last_name))  BETWEEN 1 AND 60),
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (email LIKE '%_@_%._%'),
  phone       TEXT CHECK (phone IS NULL OR length(phone) BETWEEN 7 AND 20),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  joined_at   TEXT NOT NULL DEFAULT (date('now', '+2 hours'))
);

-- ---------- User accounts (FR1) -------------------------------------
-- Staff (admin/librarian) have no member_id; every member account is
-- linked 1:1 to a members row and is deleted with it (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(username) BETWEEN 3 AND 40),
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'librarian', 'member')),
  member_id     INTEGER UNIQUE REFERENCES members (id) ON DELETE CASCADE,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now', '+2 hours')),
  CHECK ((role = 'member' AND member_id IS NOT NULL)
      OR (role <> 'member' AND member_id IS NULL))
);

-- ---------- Books (FR3) ---------------------------------------------
CREATE TABLE IF NOT EXISTS books (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  isbn             TEXT NOT NULL UNIQUE CHECK (length(isbn) IN (10, 13)),
  title            TEXT NOT NULL CHECK (length(trim(title))  BETWEEN 1 AND 200),
  author           TEXT NOT NULL CHECK (length(trim(author)) BETWEEN 1 AND 120),
  category         TEXT NOT NULL DEFAULT 'General' CHECK (length(trim(category)) BETWEEN 1 AND 60),
  publication_year INTEGER CHECK (publication_year IS NULL OR publication_year BETWEEN 1000 AND 2100),
  total_copies     INTEGER NOT NULL DEFAULT 1 CHECK (total_copies >= 0),
  available_copies INTEGER NOT NULL DEFAULT 1 CHECK (available_copies >= 0),
  created_at       TEXT NOT NULL DEFAULT (datetime('now', '+2 hours')),
  CHECK (available_copies <= total_copies)
);
CREATE INDEX IF NOT EXISTS idx_books_title    ON books (title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_books_author   ON books (author COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_books_category ON books (category);

-- ---------- Loans (FR4, FR5) ----------------------------------------
-- RESTRICT (not CASCADE) on member/book: circulation history is a
-- financial/audit record and must never vanish silently.
CREATE TABLE IF NOT EXISTS loans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id   INTEGER NOT NULL REFERENCES members (id) ON DELETE RESTRICT,
  book_id     INTEGER NOT NULL REFERENCES books   (id) ON DELETE RESTRICT,
  issued_by   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  borrowed_at TEXT NOT NULL DEFAULT (datetime('now', '+2 hours')),
  due_date    TEXT NOT NULL CHECK (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  returned_at TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'returned')),
  CHECK ((status = 'active'   AND returned_at IS NULL)
      OR (status = 'returned' AND returned_at IS NOT NULL)),
  CHECK (due_date >= date(borrowed_at))
);
-- BR4: one active loan per (member, title)
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_loan_per_title
  ON loans (member_id, book_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_loans_member_status ON loans (member_id, status);
CREATE INDEX IF NOT EXISTS idx_loans_book          ON loans (book_id);
CREATE INDEX IF NOT EXISTS idx_loans_due_active    ON loans (due_date) WHERE status = 'active';

-- ---------- Fines (FR5) ---------------------------------------------
-- A fine belongs to exactly one loan and is removed if that loan row is.
CREATE TABLE IF NOT EXISTS fines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id      INTEGER NOT NULL UNIQUE REFERENCES loans (id) ON DELETE CASCADE,
  member_id    INTEGER NOT NULL REFERENCES members (id) ON DELETE RESTRICT,
  days_overdue INTEGER NOT NULL CHECK (days_overdue > 0),
  amount_zar   REAL    NOT NULL CHECK (amount_zar > 0),
  status       TEXT    NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'paid', 'waived')),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now', '+2 hours')),
  settled_at   TEXT,
  settled_by   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  CHECK ((status = 'unpaid' AND settled_at IS NULL)
      OR (status <> 'unpaid' AND settled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_fines_member_status ON fines (member_id, status);
CREATE INDEX IF NOT EXISTS idx_fines_created       ON fines (created_at);

-- =====================================================================
-- TRIGGERS: native enforcement of the business rules
-- Messages are machine-readable codes mapped to HTTP 409 by the API.
-- =====================================================================

-- BR1, BR2, BR3: gatekeeping before a loan row is inserted
CREATE TRIGGER IF NOT EXISTS trg_loans_before_insert
BEFORE INSERT ON loans
WHEN NEW.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'MEMBER_SUSPENDED')
   WHERE (SELECT status FROM members WHERE id = NEW.member_id) = 'suspended';

  SELECT RAISE(ABORT, 'BORROW_LIMIT')
   WHERE (SELECT COUNT(*) FROM loans
           WHERE member_id = NEW.member_id AND status = 'active')
      >= (SELECT value FROM settings WHERE key = 'max_active_loans');

  SELECT RAISE(ABORT, 'OUT_OF_STOCK')
   WHERE (SELECT available_copies FROM books WHERE id = NEW.book_id) <= 0;
END;

-- BR5: stock goes down when a loan is issued
CREATE TRIGGER IF NOT EXISTS trg_loans_after_insert
AFTER INSERT ON loans
WHEN NEW.status = 'active'
BEGIN
  UPDATE books SET available_copies = available_copies - 1 WHERE id = NEW.book_id;
END;

-- Loan identity is immutable; a returned loan can never be re-opened.
CREATE TRIGGER IF NOT EXISTS trg_loans_immutable
BEFORE UPDATE OF member_id, book_id, borrowed_at, due_date ON loans
BEGIN
  SELECT RAISE(ABORT, 'LOAN_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_loans_no_reopen
BEFORE UPDATE OF status ON loans
WHEN OLD.status = 'returned'
BEGIN
  SELECT RAISE(ABORT, 'LOAN_ALREADY_RETURNED');
END;

-- BR5 + BR6: on return, restock and assess the fine automatically
CREATE TRIGGER IF NOT EXISTS trg_loans_return
AFTER UPDATE OF status ON loans
WHEN OLD.status = 'active' AND NEW.status = 'returned'
BEGIN
  UPDATE books SET available_copies = available_copies + 1 WHERE id = NEW.book_id;

  INSERT INTO fines (loan_id, member_id, days_overdue, amount_zar)
  SELECT NEW.id, NEW.member_id, late.days,
         ROUND(MIN(late.days * (SELECT value FROM settings WHERE key = 'fine_per_day_zar'),
                   (SELECT value FROM settings WHERE key = 'fine_cap_zar')), 2)
    FROM (SELECT CAST(julianday(date(NEW.returned_at)) - julianday(NEW.due_date) AS INTEGER) AS days) AS late
   WHERE late.days > 0;
END;

-- =====================================================================
-- VIEWS: reporting layer (FR4 lists, FR5 projections, FR6 reports)
-- =====================================================================
CREATE VIEW IF NOT EXISTS v_loan_details AS
WITH calc AS (
  SELECT l.*,
         CASE WHEN l.status = 'active' AND l.due_date < date('now', '+2 hours')
              THEN CAST(julianday(date('now', '+2 hours')) - julianday(l.due_date) AS INTEGER)
              ELSE 0 END AS days_overdue
    FROM loans l
)
SELECT c.id, c.member_id, m.member_no,
       m.first_name || ' ' || m.last_name AS member_name,
       c.book_id, b.title, b.author, b.isbn,
       c.borrowed_at, c.due_date, c.returned_at, c.status,
       CASE WHEN c.days_overdue > 0 THEN 1 ELSE 0 END AS is_overdue,
       c.days_overdue,
       ROUND(MIN(c.days_overdue * (SELECT value FROM settings WHERE key = 'fine_per_day_zar'),
                 (SELECT value FROM settings WHERE key = 'fine_cap_zar')), 2) AS projected_fine_zar
  FROM calc c
  JOIN members m ON m.id = c.member_id
  JOIN books   b ON b.id = c.book_id;
