// FR3 - Book catalogue: live search + filters for everyone; add/edit/delete for staff.
import { api } from '../api.js';
import { state, isStaff, isAdmin } from '../state.js';
import { esc, C, highlight, debounce, availabilityBadge, icon, $, $$, plural } from '../util.js';
import { openModal, confirmDialog, field, clearFieldErrors, showFieldErrors, formError, withBusy, toast, skeletonRows, emptyState, errorState } from '../ui.js';
import { pageHeader, tableCard } from '../page.js';

export default {
  title: 'Catalogue',
  async render(el, { params }) {
    const staff = isStaff();
    el.innerHTML = `
      ${pageHeader('Book catalogue', staff ? 'Search, add and maintain the library collection.' : 'Find a book, then ask at the desk to borrow it.',
        staff ? `<button type="button" id="add-book" class="${C.btn}">${icon('plus')} Add book</button>` : '')}
      <div class="${C.card} mb-4 p-4">
        <div class="grid gap-3 md:grid-cols-[1fr_14rem_auto] md:items-end">
          <div>
            <label for="book-search" class="${C.label}">Search by title, author or ISBN</label>
            <div class="relative">
              <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">${icon('search', 'h-4 w-4')}</span>
              <input id="book-search" data-search type="search" autocomplete="off" placeholder="e.g. Mandela, Coetzee, 9780&hellip;" class="${C.input} pl-9">
            </div>
          </div>
          <div>
            <label for="book-category" class="${C.label}">Category</label>
            <select id="book-category" class="${C.input}"><option value="">All categories</option></select>
          </div>
          <label class="flex items-center gap-2 pb-2 text-sm text-slate-700">
            <input id="book-available" type="checkbox" class="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"> Available now
          </label>
        </div>
      </div>
      <p id="result-count" class="mb-2 text-sm text-slate-500" aria-live="polite">&nbsp;</p>
      <div id="results"></div>`;

    const search = $('#book-search', el);
    const category = $('#book-category', el);
    const available = $('#book-available', el);
    const results = $('#results', el);
    let aborter = null;
    let books = [];

    // Category filter options
    api.get('/api/books/categories').then(({ data }) => {
      category.insertAdjacentHTML('beforeend', data.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join(''));
    }).catch(() => {});

    async function load() {
      if (aborter) aborter.abort();
      aborter = new AbortController();
      const q = search.value.trim();
      results.innerHTML = tableCard(`<table class="min-w-full"><tbody>${skeletonRows(5, 5)}</tbody></table>`);
      try {
        const res = await api.get('/api/books', {
          signal: aborter.signal,
          query: { q, category: category.value, available: available.checked ? 'true' : '' },
        });
        books = res.data;
        $('#result-count', el).textContent = `${plural(res.total, 'title')} found${res.total > res.data.length ? ` (showing ${res.data.length})` : ''}`;
        paint(q);
      } catch (err) {
        if (err.name === 'AbortError') return;
        results.innerHTML = `<div class="${C.card}">${errorState(err.message)}</div>`;
        $('[data-retry]', results).addEventListener('click', load);
      }
    }

    function paint(q) {
      if (!books.length) {
        results.innerHTML = `<div class="${C.card}">${emptyState({ title: 'No books match your search',
          message: 'Try a different spelling, clear the category filter, or untick "Available now".' })}</div>`;
        return;
      }
      results.innerHTML = tableCard(`
        <table class="min-w-full divide-y divide-slate-100">
          <caption class="sr-only">Library catalogue</caption>
          <thead class="bg-slate-50"><tr>
            <th scope="col" class="${C.th}">Title</th><th scope="col" class="${C.th}">Category</th>
            <th scope="col" class="${C.th} hidden md:table-cell">ISBN</th><th scope="col" class="${C.th} hidden sm:table-cell">Year</th>
            <th scope="col" class="${C.th}">Availability</th>${staff ? `<th scope="col" class="${C.th} text-right">Actions</th>` : ''}
          </tr></thead>
          <tbody class="divide-y divide-slate-100">
            ${books.map((b) => `
              <tr class="hover:bg-slate-50/70" data-id="${b.id}">
                <td class="${C.td}"><span class="font-medium text-slate-900">${highlight(b.title, q)}</span><br><span class="text-xs text-slate-500">${highlight(b.author, q)}</span></td>
                <td class="${C.td}">${esc(b.category)}</td>
                <td class="${C.td} hidden font-mono text-xs text-slate-500 md:table-cell">${highlight(b.isbn, q)}</td>
                <td class="${C.td} hidden sm:table-cell">${b.publication_year ?? '-'}</td>
                <td class="${C.td}">${availabilityBadge(b)}</td>
                ${staff ? `<td class="${C.td} text-right"><div class="flex justify-end gap-1.5">
                  <button type="button" data-action="issue" class="${C.btnSmPrimary}" ${b.available_copies <= 0 ? 'disabled title="No copies available"' : ''}>Issue</button>
                  <button type="button" data-action="edit" class="${C.btnSm}" aria-label="Edit ${esc(b.title)}">${icon('edit', 'h-4 w-4')}</button>
                  ${isAdmin() ? `<button type="button" data-action="delete" class="${C.btnSmDanger}" aria-label="Delete ${esc(b.title)}">${icon('trash', 'h-4 w-4')}</button>` : ''}
                </div></td>` : ''}
              </tr>`).join('')}
          </tbody>
        </table>`);
    }

    // Live filtering
    const debounced = debounce(load, 250);
    search.addEventListener('input', debounced);
    category.addEventListener('change', load);
    available.addEventListener('change', load);

    // Row actions (event delegation)
    results.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const book = books.find((b) => b.id === Number(btn.closest('tr').dataset.id));
      if (!book) return;
      if (btn.dataset.action === 'issue') state.navigate(`circulation?book=${book.id}`);
      if (btn.dataset.action === 'edit') bookForm(book);
      if (btn.dataset.action === 'delete') {
        const ok = await confirmDialog({ title: 'Delete this book?', danger: true, confirmLabel: 'Delete book',
          html: `<p><strong>${esc(book.title)}</strong> by ${esc(book.author)} will be permanently removed from the catalogue.</p>
                 <p class="mt-2 text-slate-500">Titles with loan history cannot be deleted.</p>` });
        if (!ok) return;
        try {
          await api.del(`/api/books/${book.id}`);
          toast('success', `"${book.title}" was deleted.`);
          load();
        } catch (err) { toast('error', err.message, { title: 'Could not delete book' }); }
      }
    });

    function bookForm(book) {
      const editing = !!book;
      const b = book || {};
      const modal = openModal({
        title: editing ? 'Edit book' : 'Add a book',
        html: `
          <form id="book-form" class="grid gap-4" novalidate>
            <div data-form-error class="empty:hidden"></div>
            ${field({ name: 'title', label: 'Title', required: true, value: b.title, autofocus: true })}
            ${field({ name: 'author', label: 'Author', required: true, value: b.author })}
            <div class="grid gap-4 sm:grid-cols-2">
              ${field({ name: 'isbn', label: 'ISBN', required: true, value: b.isbn, hint: '10 or 13 digits; hyphens are fine.' })}
              ${field({ name: 'category', label: 'Category', value: b.category || 'General', attrs: 'list="category-list"' })}
            </div>
            <datalist id="category-list">${[...category.options].filter((o) => o.value).map((o) => `<option value="${esc(o.value)}">`).join('')}</datalist>
            <div class="grid gap-4 sm:grid-cols-2">
              ${field({ name: 'publication_year', label: 'Publication year', type: 'number', value: b.publication_year ?? '', attrs: 'min="1000" max="2100"' })}
              ${field({ name: 'total_copies', label: 'Total copies', type: 'number', required: true, value: b.total_copies ?? 1, attrs: 'min="0" max="1000"',
                hint: editing ? `${b.on_loan} currently on loan.` : '' })}
            </div>
            <div class="mt-1 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" data-cancel class="${C.btnSecondary}">Cancel</button>
              <button type="submit" class="${C.btn}">${editing ? 'Save changes' : 'Add book'}</button>
            </div>
          </form>`,
        onMount: (m) => {
          const form = $('#book-form', m.el);
          $('[data-cancel]', form).addEventListener('click', () => m.close());
          form.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            clearFieldErrors(form);
            const data = Object.fromEntries(new FormData(form));
            if (data.publication_year === '') data.publication_year = null;
            try {
              await withBusy($('button[type=submit]', form), 'Saving', () =>
                (editing ? api.put(`/api/books/${b.id}`, data) : api.post('/api/books', data)));
              m.close();
              toast('success', editing ? `"${data.title}" was updated.` : `"${data.title}" was added to the catalogue.`);
              load();
            } catch (err) {
              if (!(err.details?.length && showFieldErrors(form, err.details))) formError(form, err.message);
            }
          });
        },
      });
      return modal;
    }

    $('#add-book', el)?.addEventListener('click', () => bookForm());
    await load();
    if (staff && params.new === '1') bookForm();

    // "/" jumps to search, a common convention for search-heavy pages
    const onKey = (e) => {
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) { e.preventDefault(); search.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (aborter) aborter.abort(); debounced.cancel(); };
  },
};
