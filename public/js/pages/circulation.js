// FR4 - Loan transactions & limit enforcement   FR5 - Return processing & automated ZAR fines
// Left: "Issue a book" desk with live member/book pickers and a pre-flight limit check.
// Right/below: the loans register with live search, status tabs and one-click returns.
import { api } from '../api.js';
import { state } from '../state.js';
import { esc, C, highlight, debounce, fmtZar, fmtDate, plural, badge, loanBadge, limitPips, icon, $, $$ } from '../util.js';
import { banner, clearBanner, confirmDialog, mountCombobox, withBusy, toast, skeletonRows, emptyState, errorState } from '../ui.js';
import { pageHeader, tableCard } from '../page.js';

const TABS = [
  { id: 'active', label: 'On loan' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'returned', label: 'Returned' },
  { id: 'all', label: 'All' },
];

export default {
  title: 'Circulation',
  async render(el, { params }) {
    el.innerHTML = `
      ${pageHeader('Circulation desk', 'Issue books to members and process returns. Fines are calculated automatically.')}
      <div id="desk-banner" class="mb-4 empty:hidden" aria-live="polite"></div>

      <section class="${C.card} mb-6 p-5" aria-labelledby="issue-h">
        <h2 id="issue-h" class="mb-4 flex items-center gap-2 font-semibold text-slate-900">${icon('plus', 'h-5 w-5 text-brand-600')} Issue a book</h2>
        <form id="issue-form" class="grid gap-4 lg:grid-cols-[1fr_1fr_auto] lg:items-start" novalidate>
          <div>
            <label for="member-pick" class="${C.label}">Member</label>
            <div id="member-cb" class="relative">
              <input id="member-pick" data-cb-input type="text" autocomplete="off" placeholder="Search name or LUM-0001&hellip;" class="${C.input}">
              <ul data-cb-list class="absolute z-30 mt-1 hidden max-h-64 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg"></ul>
            </div>
            <div id="member-card" class="mt-2" aria-live="polite"></div>
          </div>
          <div>
            <label for="book-pick" class="${C.label}">Book</label>
            <div id="book-cb" class="relative">
              <input id="book-pick" data-cb-input type="text" autocomplete="off" placeholder="Search title, author or ISBN&hellip;" class="${C.input}">
              <ul data-cb-list class="absolute z-30 mt-1 hidden max-h-64 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg"></ul>
            </div>
            <div id="book-card" class="mt-2" aria-live="polite"></div>
          </div>
          <div class="lg:pt-6">
            <button type="submit" id="issue-btn" class="${C.btn} w-full lg:w-auto" disabled>${icon('swap', 'h-4 w-4')} Issue book</button>
            <p id="issue-hint" class="mt-1 text-xs text-slate-500 lg:max-w-[11rem]">Choose a member and a book.</p>
          </div>
        </form>
      </section>

      <section aria-labelledby="loans-h">
        <div class="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <h2 id="loans-h" class="text-lg font-semibold text-slate-900">Loans register</h2>
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div role="tablist" aria-label="Loan status" class="inline-flex rounded-lg bg-slate-100 p-1">
              ${TABS.map((t) => `<button type="button" role="tab" id="tab-${t.id}" data-tab="${t.id}" aria-selected="false" tabindex="-1"
                class="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 aria-selected:bg-white aria-selected:text-brand-800 aria-selected:shadow-sm">${t.label}</button>`).join('')}
            </div>
            <div class="relative">
              <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">${icon('search', 'h-4 w-4')}</span>
              <input id="loan-search" type="search" autocomplete="off" aria-label="Search loans by member, book or member number" placeholder="Search loans&hellip;" class="${C.input} pl-9 sm:w-64">
            </div>
          </div>
        </div>
        <p id="loan-count" class="mb-2 text-sm text-slate-500" aria-live="polite">&nbsp;</p>
        <div id="loan-results" role="tabpanel" aria-labelledby="tab-active"></div>
      </section>`;

    const bannerSlot = $('#desk-banner', el);
    const issueBtn = $('#issue-btn', el);
    const issueHint = $('#issue-hint', el);
    const results = $('#loan-results', el);
    const search = $('#loan-search', el);
    let member = null; let book = null; let tab = 'active'; let loans = []; let policy = null;
    let aborter = null;

    // ------------------------------------------------------------ issue desk
    function memberCard() {
      const slot = $('#member-card', el);
      if (!member) { slot.innerHTML = ''; return; }
      const max = policy?.max_active_loans ?? 3;
      const atLimit = member.active_loans >= max;
      const suspended = member.status === 'suspended';
      const problems = [];
      if (suspended) problems.push('Membership suspended - cannot borrow.');
      else if (atLimit) problems.push(`Borrowing limit reached (${member.active_loans} of ${max}). A book must be returned first.`);
      if (member.overdue_loans > 0) problems.push(`${plural(member.overdue_loans, 'book')} overdue.`);
      if (member.unpaid_fines_zar > 0) problems.push(`${fmtZar(member.unpaid_fines_zar)} in unpaid fines.`);
      slot.innerHTML = `
        <div class="rounded-lg border ${suspended || atLimit ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-slate-50'} p-3 text-sm pop-in">
          <div class="flex items-center justify-between gap-2">
            <p class="font-semibold text-slate-900">${esc(member.first_name)} ${esc(member.last_name)} <span class="font-mono text-xs font-normal text-slate-500">${esc(member.member_no)}</span></p>
            ${suspended ? badge('Suspended', 'red') : badge('Active', 'green')}
          </div>
          <div class="mt-1.5 flex items-center gap-2">${limitPips(member.active_loans, max)}
            <span class="text-xs ${atLimit ? 'font-semibold text-red-700' : 'text-slate-600'}">${member.active_loans} of ${max} books on loan</span></div>
          ${problems.length ? `<ul class="mt-2 space-y-0.5 text-xs ${suspended || atLimit ? 'text-red-800' : 'text-amber-800'}">${problems.map((p) => `<li class="flex gap-1.5">${icon('warn', 'h-4 w-4')}<span>${esc(p)}</span></li>`).join('')}</ul>` : ''}
        </div>`;
    }

    function bookCard() {
      const slot = $('#book-card', el);
      if (!book) { slot.innerHTML = ''; return; }
      const none = book.available_copies <= 0;
      slot.innerHTML = `
        <div class="rounded-lg border ${none ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-slate-50'} p-3 text-sm pop-in">
          <p class="font-semibold text-slate-900">${esc(book.title)}</p>
          <p class="text-xs text-slate-600">${esc(book.author)} &middot; ${esc(book.category)}</p>
          <div class="mt-1.5 flex items-center justify-between gap-2"><span class="font-mono text-xs text-slate-500">${esc(book.isbn)}</span>
            ${none ? badge('None in', 'red') : badge(`${book.available_copies} of ${book.total_copies} in`, book.available_copies === 1 ? 'amber' : 'green')}</div>
        </div>`;
    }

    function syncIssueButton() {
      issueBtn.disabled = !(member && book);
      issueHint.textContent = !member ? 'Choose a member and a book.' : !book ? 'Now choose a book.'
        : `Due in ${policy?.loan_period_days ?? 14} days if issued today.`;
    }

    const memberPicker = mountCombobox($('#member-cb', el), {
      minChars: 0,
      emptyText: 'No members match',
      fetchItems: async (q, signal) => (await api.get('/api/members', { signal, query: { q, limit: 8 } })).data,
      getLabel: (m) => `${m.first_name} ${m.last_name} (${m.member_no})`,
      renderItem: (m, q) => `<div class="flex items-center justify-between gap-2"><span class="min-w-0 truncate">${highlight(`${m.first_name} ${m.last_name}`, q)}
        <span class="font-mono text-xs text-slate-500">${highlight(m.member_no, q)}</span></span>
        <span class="shrink-0 text-xs ${m.status === 'suspended' ? 'font-semibold text-red-700' : 'text-slate-500'}">${m.status === 'suspended' ? 'Suspended' : `${m.active_loans} on loan`}</span></div>`,
      onSelect: (m) => { member = m; memberCard(); syncIssueButton(); },
      onClear: () => { member = null; memberCard(); syncIssueButton(); },
    });

    const bookPicker = mountCombobox($('#book-cb', el), {
      minChars: 0,
      emptyText: 'No books match',
      fetchItems: async (q, signal) => (await api.get('/api/books', { signal, query: { q, limit: 8 } })).data,
      getLabel: (b) => b.title,
      renderItem: (b, q) => `<div class="flex items-center justify-between gap-2"><span class="min-w-0 truncate">${highlight(b.title, q)}
        <span class="text-xs text-slate-500">${highlight(b.author, q)}</span></span>
        <span class="shrink-0 text-xs ${b.available_copies <= 0 ? 'font-semibold text-red-700' : 'text-slate-500'}">${b.available_copies <= 0 ? 'None in' : `${b.available_copies} in`}</span></div>`,
      onSelect: (b) => { book = b; bookCard(); syncIssueButton(); },
      onClear: () => { book = null; bookCard(); syncIssueButton(); },
    });

    // Refresh the stored member/book after a transaction so the cards show the new counts.
    async function refreshSelection() {
      try {
        if (member) { member = (await api.get(`/api/members/${member.id}`)).member; memberCard(); }
        if (book) { book = (await api.get(`/api/books/${book.id}`)).book; bookCard(); }
      } catch { /* cards simply keep their last values */ }
    }

    // FR4 - issue
    $('#issue-form', el).addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!member || !book) return;
      clearBanner(bannerSlot);
      try {
        const res = await withBusy(issueBtn, 'Issuing', () =>
          api.post('/api/loans', { member_id: member.id, book_id: book.id }));
        const full = res.active_loans >= res.max_active_loans;
        banner(bannerSlot, full ? 'warn' : 'success',
          full ? `${res.message} This member has now reached the limit of ${res.max_active_loans} books.` : res.message,
          { title: full ? 'Book issued - borrowing limit reached' : 'Book issued' });
        toast('success', `Issued "${book.title}".`);
        bookPicker.clear();
        await refreshSelection();
        loadLoans();
      } catch (err) {
        const limit = err.code === 'BORROW_LIMIT';
        banner(bannerSlot, limit || err.code === 'MEMBER_SUSPENDED' ? 'error' : 'warn', err.message,
          { title: limit ? 'Borrowing limit reached' : err.code === 'MEMBER_SUSPENDED' ? 'Member suspended'
            : err.code === 'OUT_OF_STOCK' ? 'No copies available' : err.code === 'ALREADY_BORROWED' ? 'Already on loan'
            : 'Book could not be issued' });
        await refreshSelection();
      }
      bannerSlot.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });

    // ------------------------------------------------------------ loans register
    function setTab(id, { focus = false } = {}) {
      tab = id;
      $$('[data-tab]', el).forEach((b) => {
        const on = b.dataset.tab === id;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        if (on && focus) b.focus();
      });
      results.setAttribute('aria-labelledby', `tab-${id}`);
    }

    async function loadLoans() {
      if (aborter) aborter.abort();
      aborter = new AbortController();
      const q = search.value.trim();
      results.innerHTML = tableCard(`<table class="min-w-full"><tbody>${skeletonRows(5, 5)}</tbody></table>`);
      try {
        const res = await api.get('/api/loans', { signal: aborter.signal, query: { status: tab, q, limit: 100 } });
        loans = res.data; policy = res.policy;
        $('#loan-count', el).textContent = `${plural(res.total, 'loan')}${res.total > loans.length ? ` (showing ${loans.length})` : ''}`;
        paint(q);
        memberCard();
      } catch (err) {
        if (err.name === 'AbortError') return;
        results.innerHTML = `<div class="${C.card}">${errorState(err.message)}</div>`;
        $('[data-retry]', results).addEventListener('click', loadLoans);
      }
    }

    const returnButton = (l) => `<button type="button" data-return class="${l.is_overdue ? C.btnSmDanger : C.btnSm}" aria-label="Return ${esc(l.title)} from ${esc(l.member_name)}">Return</button>`;

    function paint(q) {
      if (!loans.length) {
        results.innerHTML = `<div class="${C.card}">${emptyState({
          iconName: tab === 'overdue' ? 'check' : 'swap',
          title: tab === 'overdue' ? 'Nothing overdue' : q ? 'No loans match your search' : 'No loans here yet',
          message: tab === 'overdue' ? 'Every borrowed book is within its loan period.' : q ? 'Try a different name, title or member number.' : 'Issued books will appear here.' })}</div>`;
        return;
      }
      results.innerHTML = tableCard(`
        <table class="min-w-full divide-y divide-slate-100">
          <caption class="sr-only">Loans register - ${esc(TABS.find((t) => t.id === tab).label)}</caption>
          <thead class="bg-slate-50"><tr>
            <th scope="col" class="${C.th}">Book</th><th scope="col" class="${C.th}">Member</th>
            <th scope="col" class="${C.th} hidden md:table-cell">Borrowed</th><th scope="col" class="${C.th}">Due</th>
            <th scope="col" class="${C.th}">Status</th><th scope="col" class="${C.th} hidden text-right sm:table-cell"><span class="sr-only">Actions</span></th>
          </tr></thead>
          <tbody class="divide-y divide-slate-100">
            ${loans.map((l) => `
              <tr class="${l.is_overdue ? 'bg-red-50/40' : ''} hover:bg-slate-50/70" data-id="${l.id}">
                <td class="${C.td}"><span class="font-medium text-slate-900">${highlight(l.title, q)}</span><br><span class="text-xs text-slate-500">${highlight(l.author, q)}</span></td>
                <td class="${C.td}">${highlight(l.member_name, q)}<br><span class="font-mono text-xs text-slate-500">${highlight(l.member_no, q)}</span></td>
                <td class="${C.td} hidden md:table-cell">${fmtDate(l.borrowed_at)}</td>
                <td class="${C.td}">${l.status === 'returned' ? `<span class="text-slate-500">${fmtDate(l.due_date)}</span><br><span class="text-xs text-slate-500">back ${fmtDate(l.returned_at)}</span>` : fmtDate(l.due_date)}</td>
                <td class="${C.td}">${loanBadge(l, state.today)}${l.is_overdue ? `<br><span class="text-xs font-medium text-red-700">Fine so far ${fmtZar(l.projected_fine_zar)}</span>` : ''}
                  ${l.status === 'active' ? `<div class="mt-2 sm:hidden">${returnButton(l)}</div>` : ''}</td>
                <td class="${C.td} hidden text-right sm:table-cell">${l.status === 'active' ? returnButton(l) : ''}</td>
              </tr>`).join('')}
          </tbody>
        </table>`);
    }

    // FR5 - return
    results.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-return]');
      if (!btn) return;
      const loan = loans.find((l) => l.id === Number(btn.closest('tr').dataset.id));
      if (!loan) return;
      const rate = policy?.fine_per_day_zar ?? 2;
      const ok = await confirmDialog({
        title: 'Return this book?', confirmLabel: loan.is_overdue ? 'Return & record fine' : 'Confirm return', danger: loan.is_overdue,
        html: `<p><strong>${esc(loan.title)}</strong><br><span class="text-slate-500">borrowed by ${esc(loan.member_name)} (${esc(loan.member_no)})</span></p>
          ${loan.is_overdue
            ? `<p class="mt-3 rounded-lg bg-red-50 p-3 text-red-800">This book is <strong>${plural(loan.days_overdue, 'day')}</strong> overdue.
               A fine of <strong>${fmtZar(loan.projected_fine_zar)}</strong> (${loan.days_overdue} &times; ${fmtZar(rate)}) will be recorded against the member.</p>`
            : '<p class="mt-3 text-slate-600">Returned on time - no fine will be charged.</p>'}` });
      if (!ok) return;
      clearBanner(bannerSlot);
      try {
        const res = await withBusy(btn, 'Returning', () => api.post(`/api/loans/${loan.id}/return`));
        banner(bannerSlot, res.fine ? 'warn' : 'success', res.message, { title: res.fine ? 'Returned late - fine recorded' : 'Book returned' });
        toast(res.fine ? 'warn' : 'success', res.fine ? `Fine of ${fmtZar(res.fine.amount_zar)} recorded.` : 'Book returned on time.');
        await refreshSelection();
        loadLoans();
      } catch (err) {
        banner(bannerSlot, 'error', err.message, { title: 'Return failed' });
        loadLoans();
      }
      bannerSlot.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });

    // Tabs (WAI-ARIA tabs pattern: arrow keys move between tabs)
    $('[role=tablist]', el).addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b && b.dataset.tab !== tab) { setTab(b.dataset.tab); loadLoans(); }
    });
    $('[role=tablist]', el).addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const i = TABS.findIndex((t) => t.id === tab);
      const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].id;
      setTab(next, { focus: true });
      loadLoans();
    });

    const debounced = debounce(loadLoans, 250);
    search.addEventListener('input', debounced);

    // ------------------------------------------------------------ deep links (?book=ID / ?member=ID)
    setTab(['active', 'overdue', 'returned', 'all'].includes(params.tab) ? params.tab : 'active');
    await loadLoans();
    try {
      if (params.member) memberPicker.select((await api.get(`/api/members/${Number(params.member)}`)).member);
      if (params.book) bookPicker.select((await api.get(`/api/books/${Number(params.book)}`)).book);
    } catch { /* ignore invalid deep links */ }

    return () => { if (aborter) aborter.abort(); debounced.cancel(); };
  },
};
