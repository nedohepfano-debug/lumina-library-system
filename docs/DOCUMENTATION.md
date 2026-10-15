# Lumina Library — Technical Documentation

**SDP152 · Lumina Library Resource & Member Management System · Makhanda, South Africa**

This document explains how the system is built, how it satisfies functional requirements FR1–FR6, how the
database guarantees the business rules, and how the interface applies Jakob Nielsen's ten usability heuristics.
Every claim below can be demonstrated live; Section 9 is a ready-made demo script.

---

## 1. System overview

| Layer | Technology | Why |
|---|---|---|
| Frontend | Single-page app: HTML + ES modules + **Tailwind CSS** (pre-built to `public/css/app.css`) | No framework or CDN needed at runtime, so the demo works offline |
| Backend | **Node.js 22** (`node:http`), custom `Router` with middleware-style guards | Zero npm dependencies, nothing to compile on a lab machine |
| Database | **SQLite** via Node's built-in `node:sqlite`, WAL mode, foreign keys ON | Relational integrity, constraints and triggers live *inside* the database |
| Auth | scrypt password hashes + signed HS256 tokens (JWT-compatible) in an HttpOnly cookie (or `Authorization: Bearer`) | Stateless sessions with server-side revocation checks |
| Tests | `node:test` — 34 integration tests over real HTTP, plus raw-SQL attacks on the database | `npm test` |

> **A note on Express.** The brief describes an Express backend. This codebase implements the same ideas
> (a route table, ordered middleware/guard chains, a central error handler) directly on `node:http` so that the
> project has **no runtime dependencies**. The mapping is one-to-one: `router.get(path, ...guards, handler)` ⇔
> `app.get(path, ...middleware, handler)`; `ApiError` + `sendError` ⇔ Express error-handling middleware; the guards
> in `src/auth.js` ⇔ Express auth middleware. Porting to Express is mechanical if the course requires it.

### 1.1 Architecture

```
 Browser (SPA)                         Node.js process                          SQLite file
┌──────────────────┐   JSON / HTTPS   ┌──────────────────────────────┐          ┌───────────────────┐
│ public/index.html│ ───────────────► │ server.js  (dispatcher)      │          │ data/lumina.db    │
│ js/app.js router │   cookie/Bearer  │  1. security headers (CSP…)  │          │                   │
│ js/pages/*.js    │                  │  2. route match (405/404)    │  SQL     │ tables + CHECKs   │
│ js/ui.js  (kit)  │ ◄─────────────── │  3. JSON body parse (20 KB)  │ ───────► │ triggers (rules)  │
│ js/api.js (fetch)│   uniform errors │  4. guards: authenticate →   │          │ views  (reports)  │
└──────────────────┘                  │     requireRole              │ ◄─────── │ FK RESTRICT/CASC. │
                                      │  5. validate() whitelist     │          └───────────────────┘
                                      │  6. handler → DB             │
                                      │  7. error middleware         │
                                      └──────────────────────────────┘
```

### 1.2 Source layout

```
server.js            entry point: dispatcher, error middleware, startup
src/schema.sql       tables, constraints, triggers, views   (the business rules)
src/db.js            connection, transaction helper, policy lookup
src/security.js      scrypt hashing, token signing/verification, secret loading
src/auth.js          authenticate + requireRole guards (FR1)
src/validate.js      declarative whitelist validation
src/http.js          router, body parser, cookies, rate limiter, security headers, static files
src/errors.js        ApiError + translation of SQLite errors into friendly API errors
src/routes/*.js      auth · members · books · loans · fines · reports
src/seed.js          demo data (dates are relative to "today", so scenarios always work)
public/              the single-page frontend
tests/api.test.js    34 integration tests
```

---

## 2. Database design

### 2.1 Entity-relationship diagram

```mermaid
erDiagram
    MEMBERS ||--o| USERS  : "has login (CASCADE)"
    MEMBERS ||--o{ LOANS  : "borrows (RESTRICT)"
    BOOKS   ||--o{ LOANS  : "is lent (RESTRICT)"
    USERS   ||--o{ LOANS  : "issued_by (SET NULL)"
    LOANS   ||--o| FINES  : "may incur (CASCADE)"
    MEMBERS ||--o{ FINES  : "owes (RESTRICT)"
    USERS   ||--o{ FINES  : "settled_by (SET NULL)"

    MEMBERS { int id PK  text member_no UK  text first_name  text last_name  text email UK  text phone  text status  text joined_at }
    USERS   { int id PK  text username UK  text password_hash  text role  int member_id FK_UK  int is_active }
    BOOKS   { int id PK  text isbn UK  text title  text author  text category  int publication_year  int total_copies  int available_copies }
    LOANS   { int id PK  int member_id FK  int book_id FK  int issued_by FK  text borrowed_at  text due_date  text returned_at  text status }
    FINES   { int id PK  int loan_id FK_UK  int member_id FK  int days_overdue  real amount_zar  text status  text settled_at  int settled_by FK }
    SETTINGS{ text key PK  real value  text description }
```

### 2.2 Relationships and referential actions

| Relationship | Cardinality | On delete | Reason |
|---|---|---|---|
| `users.member_id → members.id` | 1 member : 0..1 login | **CASCADE** | Deleting a member must never leave an orphan login that could be reused |
| `loans.member_id → members.id` | 1 : many | **RESTRICT** | Circulation history is an audit record; it must not vanish silently |
| `loans.book_id → books.id` | 1 : many | **RESTRICT** | Same reason; retire a title by setting `total_copies = 0` |
| `loans.issued_by → users.id` | many : 1 | **SET NULL** | Keep the loan if a staff account is removed |
| `fines.loan_id → loans.id` | 1 loan : 0..1 fine (`UNIQUE`) | **CASCADE** | A fine has no meaning without its loan |
| `fines.member_id → members.id` | many : 1 | **RESTRICT** | Unpaid debt blocks deletion of the debtor |
| `fines.settled_by → users.id` | many : 1 | **SET NULL** | Keep the financial record |

### 2.3 Constraints that protect the data

| Table | Constraint | Purpose |
|---|---|---|
| `users` | `CHECK (role='member' AND member_id NOT NULL OR role<>'member' AND member_id IS NULL)` | Staff have no member record; every member account links to exactly one |
| `books` | `CHECK (available_copies >= 0 AND available_copies <= total_copies)` | Stock can never go negative or exceed ownership |
| `books` | `CHECK (length(isbn) IN (10,13))`, `UNIQUE(isbn)` | Valid, unique identifiers |
| `members` | `UNIQUE(email COLLATE NOCASE)`, email pattern `CHECK`, status `IN ('active','suspended')` | No duplicate registrations |
| `loans` | `CHECK (status='active' AND returned_at IS NULL OR status='returned' AND returned_at IS NOT NULL)` | State machine consistency |
| `loans` | `UNIQUE (member_id, book_id) WHERE status='active'` (partial index) | One active loan per title per member |
| `fines` | `CHECK (days_overdue > 0 AND amount_zar > 0)`, `UNIQUE(loan_id)` | One positive fine per late loan |
| `fines` | `CHECK (status='unpaid' AND settled_at IS NULL OR status<>'unpaid' AND settled_at IS NOT NULL)` | A fine is either open or settled, never both |
| `settings` | `CHECK (value >= 0)` | Policy values (limit, loan period, fine rate, fine cap) are data, not code |

### 2.4 Business rules enforced natively by triggers

| Rule | Trigger | Error code raised |
|---|---|---|
| **BR1** A member may hold at most `max_active_loans` (3) books | `trg_loans_before_insert` | `BORROW_LIMIT` |
| **BR2** A suspended member cannot borrow | `trg_loans_before_insert` | `MEMBER_SUSPENDED` |
| **BR3** A book with no available copies cannot be lent | `trg_loans_before_insert` | `OUT_OF_STOCK` |
| **BR4** No two active loans of the same title for one member | partial unique index | `UNIQUE constraint` → `ALREADY_BORROWED` |
| **BR5** Stock decreases on issue, increases on return | `trg_loans_after_insert`, `trg_loans_return` | — |
| **BR6** A late return creates a ZAR fine: `MIN(days_late × fine_per_day_zar, fine_cap_zar)` | `trg_loans_return` | — |
| Loan identity is immutable; a returned loan cannot be re-opened | `trg_loans_immutable`, `trg_loans_no_reopen` | `LOAN_IMMUTABLE`, `LOAN_ALREADY_RETURNED` |

**Why triggers?** The API validates input and writes friendly messages, but the *rules* live in the database, so
they hold for every client — a future mobile app, a script, or someone typing SQL. The test suite proves this by
inserting a 4th loan with raw SQL and asserting that SQLite itself raises `BORROW_LIMIT`.

**Fine calculation.** Days late are counted from the due date (the due date itself is not late):
`days = julianday(date(returned_at)) − julianday(due_date)`. Defaults: **R2.00/day, capped at R100.00 per loan,
14-day loan period.** Example: due 4 Oct, returned 15 Oct → 11 days × R2.00 = **R22.00**.
While a book is still out, the view `v_loan_details` exposes a live `projected_fine_zar`, so staff and members
see what is accruing before the return happens.

### 2.5 Views (reporting layer)

`v_loan_details` joins loans, members and books and derives `is_overdue`, `days_overdue` and
`projected_fine_zar`. Dashboards, the loans register and the weekly report all read from it, so there is a
single definition of "overdue".

### 2.6 Time zone

All timestamps are stored in **South African Standard Time** (`datetime('now','+2 hours')`, SAST has no DST).
The server clock is exposed at `/api/health`, and the UI uses it for "due in N days" badges so a wrong
laptop clock cannot corrupt what users see.

---

## 3. Security architecture (FR1)

| Concern | Implementation |
|---|---|
| Password storage | `scrypt` (N=16384, r=8, p=1) with a unique 16-byte salt per user; constant-time comparison |
| Username enumeration | One generic message, and a dummy scrypt is always computed so timing does not reveal valid usernames |
| Session | HS256-signed token, 8-hour expiry, delivered as `HttpOnly; SameSite=Strict` cookie (`Secure` + HSTS in production) or `Authorization: Bearer` |
| Revocation | The user is **reloaded from the database on every request**; deactivation, role change or password change takes effect immediately (a password fingerprint inside the token invalidates all older tokens) |
| Authorisation | Guard chain `authenticate → requireRole(...)`. Roles: `admin`, `librarian`, `member` |
| CSRF | Cookie-authenticated writes must carry `X-Requested-With: lumina-web`, which browsers will not attach cross-site without a CORS preflight; plus `SameSite=Strict` |
| Brute force | 10 failed sign-ins per IP per 15 minutes → `429` with `Retry-After` |
| Input validation | Declarative whitelist (`src/validate.js`): unknown fields dropped (no mass assignment), all errors collected per field |
| SQL injection | 100 % parameterised statements; `LIKE` wildcards in user input are escaped |
| XSS | Every dynamic string is HTML-escaped (`esc()`); strict CSP: `default-src 'self'`, no inline script, no third-party scripts |
| CSV injection | Cells starting with `= + - @` are prefixed so Excel cannot execute them |
| Request limits | 20 KB JSON body limit (`413`), `Content-Type` enforced (`415`), static path-traversal and dotfile blocking |
| Headers | CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `COOP`, `Permissions-Policy` |
| Errors | One envelope: `{ "error": { code, message, details[], requestId } }`. Unknown failures return a generic 500 with a reference ID; stack traces never leave the server |

### 3.1 Role capabilities

| Capability | Member | Librarian | Admin |
|---|:--:|:--:|:--:|
| Browse / search catalogue | ✔ | ✔ | ✔ |
| See own loans, fines, profile | ✔ | ✔ (all) | ✔ (all) |
| Register / edit members, reset passwords | | ✔ | ✔ |
| Add / edit books | | ✔ | ✔ |
| Issue and return books | | ✔ | ✔ |
| Record fine payment | | ✔ | ✔ |
| Waive a fine | | | ✔ |
| Delete members / books | | | ✔ |
| Weekly reports and CSV export | | ✔ | ✔ |

---

## 4. API reference

Base path `/api`. All bodies are JSON. 🔓 = public · 👤 = any signed-in user · 🧑‍💼 = staff (librarian/admin) · 🛡 = admin only.

| Method & path | Access | Req. | Purpose |
|---|---|---|---|
| `GET /health` | 🔓 | — | Status, SAST clock, demo-account list (only when `DEMO_MODE` is on) |
| `POST /auth/login` | 🔓 | FR1 | `{username, password}` → user + cookie + token |
| `POST /auth/logout` | 🔓 | FR1 | Clears the cookie |
| `GET /auth/me` | 👤 | FR1 | Current user |
| `POST /auth/change-password` | 👤 | FR1 | Policy-checked; re-issues the session |
| `GET /members?q=&status=&page=&limit=` | 🧑‍💼 | FR2 | Live-search registry with loan/fine counts |
| `GET /members/:id` | 👤 (own only for members) | FR2 | Profile |
| `POST /members` | 🧑‍💼 | FR2 | Creates member **and** login in one transaction; returns a one-time temporary password |
| `PUT /members/:id` | 🧑‍💼 | FR2 | Partial update (incl. suspend/reactivate) |
| `DELETE /members/:id` | 🛡 | FR2 | Refused (`409 MEMBER_HAS_HISTORY`) if loan/fine history exists |
| `POST /members/:id/reset-password` | 🧑‍💼 | FR1/2 | One-time temporary password |
| `GET /books?q=&category=&available=&page=&limit=` | 👤 | FR3 | Search title / author / ISBN |
| `GET /books/categories`, `GET /books/:id` | 👤 | FR3 | Filter options, single book |
| `POST /books`, `PUT /books/:id` | 🧑‍💼 | FR3 | Create / edit; changing `total_copies` adjusts availability atomically |
| `DELETE /books/:id` | 🛡 | FR3 | Refused (`409 BOOK_HAS_HISTORY`) if the title has loan history |
| `GET /loans?status=active\|overdue\|returned\|all&q=&member_id=` | 👤 (members see own only) | FR4 | Loans register with live projected fines |
| `POST /loans` | 🧑‍💼 | FR4 | `{member_id, book_id}`; due date = today + `loan_period_days` |
| `POST /loans/:id/return` | 🧑‍💼 | FR5 | Restocks and (if late) creates the fine; responds with the message to display |
| `GET /fines?status=&q=&member_id=` | 👤 (members see own only) | FR5 | Ledger + totals |
| `POST /fines/:id/settle` | 🧑‍💼 (`waive` = 🛡) | FR5 | `{action: 'pay' \| 'waive'}` |
| `GET /reports/summary` | 🧑‍💼 | FR6 | Dashboard numbers |
| `GET /reports/weekly?week_start=` | 🧑‍💼 | FR6 | Seven-day financial & overdue report (default: last 7 days) |
| `GET /reports/weekly.csv?week_start=` | 🧑‍💼 | FR6 | Same report as an Excel-ready CSV download |

**Status codes used:** `200/201/204` success · `400` validation (with per-field `details`) · `401` not signed in ·
`403` forbidden / CSRF · `404` · `405` (with `Allow` header) · `409` business-rule conflict (`BORROW_LIMIT`,
`OUT_OF_STOCK`, `MEMBER_SUSPENDED`, `ALREADY_BORROWED`, …) · `413` · `415` · `422` constraint violation · `429` · `500`.

### 4.1 Request pipeline (what happens to `POST /api/loans`)

1. Security headers applied; request ID generated (`X-Request-Id`).
2. `Router.match` → unknown path `404`, wrong verb `405`.
3. JSON body parsed (type and size checked).
4. Guard `authenticate`: verify token → reload user from DB → CSRF header check for cookie sessions.
5. Guard `requireRole('admin','librarian')`.
6. Handler: `validate()` whitelists `member_id`, `book_id`; looks up both records (`404` if missing).
7. `INSERT INTO loans …` — the **database trigger** checks suspension, the 3-book limit and stock.
8. If SQLite aborts with `BORROW_LIMIT`, the handler counts the member's active loans and replies
   `409 "Borrowing limit reached: Sipho Ndlovu already holds 3 of 3 books. A book must be returned before another can be issued."`
9. On success: `201` with the loan, the new count (`2 of 3`) and a ready-to-display message.
10. Any unexpected exception reaches the central error middleware → safe `500` with a reference ID.

---

## 5. Requirement traceability matrix

| Req. | What it means | Screen | API | Database mechanism | Automated tests |
|---|---|---|---|---|---|
| **FR1** Secure access | Sign-in, roles, protected data | Sign-in page, role-based navigation & dashboards, change-password dialog | `/auth/*`, guards on every route | `users.role` CHECK, member↔user 1:1 | 10 FR1 tests + 5 validation/security tests (anonymous 401, role 403, token tampering, `alg=none`, CSRF, password-change revocation, 429 rate limit, own-data scoping) |
| **FR2** Member CRUD | Register, view, edit, suspend, delete | Members registry (live search, status filter, modals) | `/members*` | `UNIQUE` email, CASCADE to login, RESTRICT to history | create→read→update→delete, duplicate email, delete-with-history refused |
| **FR3** Book CRUD & search | Maintain catalogue; search | Catalogue (live search by title/author/ISBN, category, "available now") | `/books*` | ISBN `CHECK` + `UNIQUE`, stock `CHECK`s | CRUD, ISBN normalisation, filters, copies-in-use guard, delete-with-history refused |
| **FR4** Loans & limit | Issue books, max 3 per member | Circulation desk: live member & book pickers, pre-flight member card, success / limit-reached banners | `POST /loans` | `trg_loans_before_insert`, partial unique index, stock trigger | 4th loan refused, duplicate title, out-of-stock, suspended, **limit enforced via raw SQL**, limit read from settings |
| **FR5** Returns & ZAR fines | Process returns; fines automatic | Return confirmation shows the fine **before** it is charged; Fines ledger (pay / waive) | `POST /loans/:id/return`, `/fines*` | `trg_loans_return`, fine `CHECK`s, `v_loan_details` | on-time (no fine), late (6 days → R12.00), cap (R100.00), projected fines, pay/waive permissions, double-settle refused |
| **FR6** Weekly financial & overdue report | Weekly totals and overdue list | Reports page: KPIs, daily chart + table, overdue list, top books, week navigation, CSV, print/PDF | `/reports/*` | Views + aggregate queries | totals reconcile with daily rows, CSV headers/BOM/injection safety, custom week, bad date `400`, member `403` |

---

## 6. Frontend architecture

* **Single-page app** with a hash router (`#/circulation?book=3`) — back/forward and deep links work, no server routing needed.
* **Role-based UI.** The same login lands on different dashboards: staff see operational KPIs, overdue loans and quick actions; members see their own borrowing-slot meter, loans, fines and history. Navigation items are generated from the role, and the router refuses (with an explanation) pages a role may not open. The server enforces the same rules independently.
* **Reactive components** (no framework): live search with debounce + request cancellation (`AbortController`) so stale responses never overwrite fresh ones; accessible combobox pickers; tabbed registers; skeleton loaders; optimistic busy-button states.
* **Real-time feedback.** Transactions raise a persistent in-page **banner** (success / warning / error with a title and the exact server message) *and* a transient **toast**. Examples: *"Borrowing limit reached — Sipho Ndlovu already holds 3 of 3 books…"*, *"Book issued — 3 of 3 books on loan"*, *"Returned late — Fine of R22.00 recorded (11 × R2.00)"*.
* **Accessibility.** Skip link, landmark regions, `aria-live` status areas, focus moved to the page heading on navigation, focus-trapped modal dialogs that restore focus on close, WAI-ARIA tabs and combobox keyboard patterns, visible focus rings, `prefers-reduced-motion` respected, status never conveyed by colour alone (badges carry text).
* **Responsive.** Tested at 390 px (phone) and 1280 px: tables scroll inside their cards, secondary columns collapse, and row actions move under the status badge on small screens. A print stylesheet makes the weekly report print/PDF-ready.

---

## 7. Usability heuristics (Jakob Nielsen)

| # | Heuristic | How Lumina applies it (where to see it) |
|---|---|---|
| 1 | **Visibility of system status** | Skeleton loaders while data loads; busy spinners on buttons (*"Issuing…"*); live result counts (*"3 titles found"*); due-date badges (*"Due in 9 days"*, *"Overdue 11 days"*); the borrowing-slot pips (●●○) on the member card and member dashboard; success/error banners and toasts after every transaction. |
| 2 | **Match between system and the real world** | Library vocabulary (*On loan, Returned, Overdue, Issue, Return, Mark paid*); money in Rand (`R22.00`); dates as *14 Oct 2026*; South African time; a member number format (`LUM-0001`) like a physical library card. |
| 3 | **User control and freedom** | Every dialog closes with Esc, ✕, backdrop or Cancel; banners and toasts are dismissible; clearing a picker resets the form; destructive actions are confirmed first; browser back/forward work because every screen has a URL; Sign out is always visible. *(Honest limitation: a completed return cannot be undone — by design, because it triggers stock and fine changes. The confirmation dialog compensates.)* |
| 4 | **Consistency and standards** | One UI kit (`ui.js`, `util.js`) drives every screen: identical search bars, tables, badges, modals and buttons. Colour semantics are fixed: green = good, amber = attention, red = problem. Standard WAI-ARIA patterns for tabs, dialogs and comboboxes. Same error envelope across the whole API. |
| 5 | **Error prevention** | The circulation desk shows a **pre-flight member card** (limit, suspension, overdue books, unpaid fines) *before* the librarian presses Issue; the Issue button stays disabled until both member and book are chosen; the catalogue disables *Issue* for books with no copies; the return dialog states the fine before it is charged; delete actions need confirmation; form inputs carry type/min/max limits; and the database refuses invalid states even if the UI is bypassed. |
| 6 | **Recognition rather than recall** | Staff never type IDs — they search members and books in live pickers that show status and availability. Matches are highlighted in results. Field hints explain formats (*"10 or 13 digits; hyphens are fine"*). Demo accounts are one click on the sign-in page. The catalogue's *Issue* button pre-fills the circulation desk. |
| 7 | **Flexibility and efficiency of use** | `/` jumps to catalogue search; arrow keys move through tabs and picker results, Enter selects; deep links (`#/circulation?member=2`); dashboard quick actions; CSV export and print/PDF for reports; debounced instant search for experts and plain browsing for novices. |
| 8 | **Aesthetic and minimalist design** | Each screen has one primary action; members see only two navigation items; secondary table columns appear only when there is room; helpful empty states replace blank tables; whitespace and a restrained teal/amber palette keep focus on the task. |
| 9 | **Help users recognise, diagnose, and recover from errors** | Messages are plain language and say what to do next (*"A book must be returned before another can be issued."*); validation errors appear under the exact field with `aria-invalid` and focus moved to the first problem; network failures offer **Try again**; unexpected server errors show a short reference ID instead of a stack trace. |
| 10 | **Help and documentation** | Contextual help instead of a manual: field hints, policy text on the Fines page (*R2.00 per day, capped at R100.00*), guidance in empty states (*"Browse the catalogue to find your next read"*), tooltips, and this document for staff training. *(Honest limitation: there is no separate in-app help page.)* |

---

## 8. Quality assurance

* **`npm test` → 34 passing integration tests**, run against a real HTTP server with an in-memory database
  (seeded with the same demo data). They cover each FR, role separation, validation, security headers and
  the database rules (raw-SQL attacks on triggers, CHECKs and foreign keys).
* **Browser walkthrough** (headless Chromium, desktop 1280 px and phone 390 px): sign-in as each role; limit-reached
  error; successful issue; overdue return with R22.00 fine; mark-paid; weekly report and CSV download;
  member forbidden from a staff page; wrong-password message; no layout overflow on any screen; no unexpected
  console errors (only the intentional 401/409 responses).
* **Not yet covered** (be upfront with the panel): other browsers/devices, load testing, screen-reader testing with
  real assistive technology, and HTTPS deployment (use a TLS reverse proxy such as Caddy or nginx and set `NODE_ENV=production`).

### 8.1 Known limitations and production notes

* `DEMO_MODE` (default on) lists demo credentials on the sign-in page. **Set `DEMO_MODE=false` for any real deployment.**
* The login rate limiter is in memory (resets on restart, per-IP). Behind a reverse proxy, forward the real client IP.
* SQLite handles one writer at a time — plenty for one community library, not for hundreds of concurrent librarians.
* Fines are assessed on return (and projected while overdue); payments are recorded at the desk, there is no online payment gateway.
* No e-mail/SMS reminders yet — a natural extension using `v_loan_details`.
* `public/css/app.css` is pre-built. After changing Tailwind class names run `npm install --save-dev tailwindcss` once and then `npm run build:css`.

---

## 9. Live demo script (about 6 minutes)

Start fresh: `npm run reset && npm start`, then open <http://localhost:3000>. Demo data is dated relative to today, so every scenario below works on any date.

| # | Do this | What the audience sees | Requirement |
|---|---|---|---|
| 1 | Click **Librarian** on the sign-in page | Staff dashboard: KPIs, overdue list, quick actions. Navigation has 6 items | FR1 |
| 2 | **Circulation** → member box: type `LUM-0002` → pick *Sipho Ndlovu*; book box: `Hobbit` → pick it → **Issue book** | Red banner: *"Borrowing limit reached: Sipho Ndlovu already holds 3 of 3 books…"*. The member card shows ●●● and the warnings *before* you clicked | FR4 |
| 3 | Change member to *Anele Jacobs* (2 books), book `Spud`, **Issue book** | Banner: *"Spud issued to Anele Jacobs. Due …(3 of 3 books on loan)"* plus a limit-reached notice; the loans register updates | FR4 |
| 4 | **Overdue** tab → **Return** on *Born a Crime* | Dialog states *"11 days overdue — a fine of R22.00 (11 × R2.00) will be recorded"*; confirm → amber banner *"Fine of R22.00 recorded"* | FR5 |
| 5 | **Fines** → **Mark paid** on that fine; point out there is no **Waive** button for a librarian | Totals update; banner *"Payment recorded"* | FR5, FR1 |
| 6 | **Members** → type `thandi` (live filter) → **Register member** with a new name/e-mail | Member number + one-time temporary password dialog | FR2 |
| 7 | **Catalogue** → press `/`, type `coetzee`; click **Issue** on a book | Instant filter with highlighted matches; deep-link into circulation with the book pre-selected | FR3 |
| 8 | **Reports** → **Download CSV**, then **Print / PDF** | Weekly totals, daily chart, overdue list; file opens in Excel with R amounts | FR6 |
| 9 | Sign out → **Member (overdue book)** (`LUM-0001`) | Member dashboard only; open `#/members` by hand → *"Access restricted"* toast and redirect | FR1 |
| 10 | *(Optional, for the database marker)* run the command below | The database itself rejects a 4th loan | FR4 |

```bash
# Proves the 3-book limit lives in SQLite, not just in the API (run while the server is stopped).
node --disable-warning=ExperimentalWarning -e "
const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('data/lumina.db');
db.exec('PRAGMA foreign_keys=ON');
try { db.exec(\"INSERT INTO loans (member_id, book_id, due_date) VALUES (2, 13, date('now','+14 days'))\"); }
catch (e) { console.log('Database refused the loan ->', e.message); }"
```

Expected output: `Database refused the loan -> BORROW_LIMIT`.

**Sign-ins:** `admin / Admin@123` · `librarian / Librarian@123` · `LUM-0002` (3 books, at the limit) and `LUM-0001` (overdue book) with `Member@123`.
