'use strict';
/** FR3 - Book CRUD & search. Everyone signed in can browse; only staff can change the catalogue. */
const { ApiError, isSqliteError } = require('../errors');
const { T, validate, idParam, likePattern } = require('../validate');
const { staff, adminOnly, anyUser } = require('../auth');
const { tx } = require('../db');

const BOOK_SELECT = `
  SELECT id, isbn, title, author, category, publication_year, total_copies, available_copies,
         (total_copies - available_copies) AS on_loan
    FROM books`;

const bookFields = (required) => ({
  isbn: T.str({ required, label: 'ISBN',
    transform: (v) => v.replace(/[\s-]/g, '').toUpperCase(),
    pattern: /^(\d{13}|\d{9}[\dX])$/, patternMessage: 'ISBN must be 10 or 13 digits (hyphens allowed).' }),
  title: T.str({ required, max: 200, label: 'Title' }),
  author: T.str({ required, max: 120, label: 'Author' }),
  category: T.str({ max: 60, label: 'Category', default: required ? 'General' : undefined }),
  publication_year: T.int({ nullable: true, min: 1000, max: 2100, label: 'Publication year' }),
  total_copies: T.int({ min: 0, max: 1000, label: 'Total copies', default: required ? 1 : undefined }),
});

function getBook(db, id) {
  const b = db.prepare(`${BOOK_SELECT} WHERE id = ?`).get(id);
  if (!b) throw new ApiError(404, 'NOT_FOUND', 'Book not found.');
  return b;
}

module.exports = function register(router) {
  // GET /api/books?q=&category=&available=true&page=&limit=
  router.get('/api/books', ...anyUser, (ctx) => {
    const f = validate({
      q: T.str({ max: 100 }),
      category: T.str({ max: 60 }),
      available: T.bool(),
      page: T.int({ min: 1, default: 1 }),
      limit: T.int({ min: 1, max: 200, default: 100 }),
    }, ctx.query);
    const q = f.q ? likePattern(f.q) : null;
    const where = `WHERE (? IS NULL OR title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' OR isbn LIKE ? ESCAPE '\\')
                     AND (? IS NULL OR category = ?)
                     AND (? IS NULL OR available_copies > 0)`;
    const params = [q, q, q, q, f.category ?? null, f.category ?? null, f.available ? 1 : null];
    const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM books ${where}`).get(...params).n;
    const data = ctx.db.prepare(
      `${BOOK_SELECT} ${where} ORDER BY title COLLATE NOCASE LIMIT ? OFFSET ?`)
      .all(...params, f.limit, (f.page - 1) * f.limit);
    return { data, total, page: f.page, limit: f.limit };
  });

  // GET /api/books/categories
  router.get('/api/books/categories', ...anyUser, (ctx) => ({
    data: ctx.db.prepare('SELECT DISTINCT category FROM books ORDER BY category COLLATE NOCASE')
      .all().map((r) => r.category),
  }));

  // GET /api/books/:id
  router.get('/api/books/:id', ...anyUser, (ctx) => ({ book: getBook(ctx.db, idParam(ctx)) }));

  // POST /api/books
  router.post('/api/books', ...staff, (ctx) => {
    const b = validate(bookFields(true), ctx.body);
    const r = ctx.db.prepare(
      `INSERT INTO books (isbn, title, author, category, publication_year, total_copies, available_copies)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(b.isbn, b.title, b.author, b.category, b.publication_year ?? null, b.total_copies, b.total_copies);
    ctx.status = 201;
    return { book: getBook(ctx.db, Number(r.lastInsertRowid)) };
  });

  // PUT /api/books/:id   (partial; changing total_copies adjusts availability atomically)
  router.put('/api/books/:id', ...staff, (ctx) => {
    const id = idParam(ctx);
    const fields = validate(bookFields(false), ctx.body, { partial: true });
    if (!Object.keys(fields).length) throw new ApiError(400, 'VALIDATION_ERROR', 'No changes were provided.');

    tx(ctx.db, () => {
      const current = getBook(ctx.db, id);
      const sets = Object.keys(fields);
      const values = sets.map((k) => fields[k]);
      if (fields.total_copies !== undefined) {
        const available = current.available_copies + (fields.total_copies - current.total_copies);
        if (available < 0) {
          throw new ApiError(409, 'COPIES_IN_USE',
            `${current.on_loan} cop${current.on_loan === 1 ? 'y is' : 'ies are'} currently on loan, so total copies cannot go below ${current.on_loan}.`);
        }
        sets.push('available_copies');
        values.push(available);
      }
      ctx.db.prepare(`UPDATE books SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...values, id);
    });
    return { book: getBook(ctx.db, id) };
  });

  // DELETE /api/books/:id   (admin only; refused if the title has any circulation history)
  router.delete('/api/books/:id', ...adminOnly, (ctx) => {
    const id = idParam(ctx);
    const book = getBook(ctx.db, id);
    try {
      ctx.db.prepare('DELETE FROM books WHERE id = ?').run(id);
    } catch (err) {
      if (isSqliteError(err) && /FOREIGN KEY/.test(err.message)) {
        throw new ApiError(409, 'BOOK_HAS_HISTORY',
          `"${book.title}" has loan history and cannot be deleted. Set its total copies to 0 to retire it.`);
      }
      throw err;
    }
    return { deleted: true, id };
  });
};
