// FR5 (cont.) - Fines ledger: filter, search, collect payment, waive (admin only).
import { api } from '../api.js';
import { isAdmin } from '../state.js';
import { esc, C, highlight, debounce, fmtZar, fmtDate, plural, badge, icon, $, $$ } from '../util.js';
import { banner, clearBanner, confirmDialog, withBusy, toast, skeletonRows, emptyState, errorState } from '../ui.js';
import { pageHeader, statCard, tableCard } from '../page.js';

const FILTERS = [
  { id: 'unpaid', label: 'Unpaid' }, { id: 'paid', label: 'Paid' },
  { id: 'waived', label: 'Waived' }, { id: 'all', label: 'All' },
];
const TONE = { unpaid: 'amber', paid: 'green', waived: 'slate' };

export default {
  title: 'Fines',
  async render(el) {
    el.innerHTML = `
      ${pageHeader('Fines ledger', 'Overdue fines are created automatically when a late book is returned (R2.00 per day, capped at R100.00 per loan).')}
      <div id="fine-banner" class="mb-4 empty:hidden" aria-live="polite"></div>
      <div id="fine-totals" class="mb-5 grid gap-4 sm:grid-cols-2"></div>
      <div class="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div role="tablist" aria-label="Fine status" class="inline-flex self-start rounded-lg bg-slate-100 p-1">
          ${FILTERS.map((t) => `<button type="button" role="tab" data-tab="${t.id}" aria-selected="false" tabindex="-1"
            class="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 aria-selected:bg-white aria-selected:text-brand-800 aria-selected:shadow-sm">${t.label}</button>`).join('')}
        </div>
        <div class="relative">
          <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">${icon('search', 'h-4 w-4')}</span>
          <input id="fine-search" type="search" autocomplete="off" aria-label="Search fines by member, member number or book" placeholder="Search member or book&hellip;" class="${C.input} pl-9 md:w-72">
        </div>
      </div>
      <p id="fine-count" class="mb-2 text-sm text-slate-500" aria-live="polite">&nbsp;</p>
      <div id="fine-results"></div>`;

    const results = $('#fine-results', el);
    const search = $('#fine-search', el);
    const slot = $('#fine-banner', el);
    let tab = 'unpaid'; let fines = []; let aborter = null;

    function setTab(id, focus = false) {
      tab = id;
      $$('[data-tab]', el).forEach((b) => {
        const on = b.dataset.tab === id;
        b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
        if (on && focus) b.focus();
      });
    }

    async function load() {
      if (aborter) aborter.abort();
      aborter = new AbortController();
      const q = search.value.trim();
      results.innerHTML = tableCard(`<table class="min-w-full"><tbody>${skeletonRows(4, 6)}</tbody></table>`);
      try {
        const res = await api.get('/api/fines', { signal: aborter.signal, query: { status: tab, q } });
        fines = res.data;
        // Totals always reflect the current search, regardless of the status tab.
        const all = tab === 'all' ? res : await api.get('/api/fines', { signal: aborter.signal, query: { status: 'all', q } });
        $('#fine-totals', el).innerHTML = `
          ${statCard({ label: 'Outstanding (unpaid)', value: fmtZar(all.totals.unpaid_zar), tone: all.totals.unpaid_zar ? 'amber' : 'green', iconName: 'cash' })}
          ${statCard({ label: 'Collected (paid)', value: fmtZar(all.totals.paid_zar), tone: 'green', iconName: 'check' })}`;
        $('#fine-count', el).textContent = plural(fines.length, 'fine');
        paint(q);
      } catch (err) {
        if (err.name === 'AbortError') return;
        results.innerHTML = `<div class="${C.card}">${errorState(err.message)}</div>`;
        $('[data-retry]', results).addEventListener('click', load);
      }
    }

    const fineActions = (f) => `<div class="flex justify-end gap-1.5 max-sm:justify-start">
      <button type="button" data-act="pay" class="${C.btnSmPrimary}" aria-label="Record payment of ${fmtZar(f.amount_zar)} from ${esc(f.member_name)}">Mark paid</button>
      ${isAdmin() ? `<button type="button" data-act="waive" class="${C.btnSm}" aria-label="Waive fine for ${esc(f.member_name)}">Waive</button>` : ''}</div>`;

    function paint(q) {
      if (!fines.length) {
        results.innerHTML = `<div class="${C.card}">${emptyState({ iconName: 'cash',
          title: tab === 'unpaid' && !q ? 'No unpaid fines' : 'No fines found',
          message: tab === 'unpaid' && !q ? 'Every fine has been settled.' : 'Try another status tab or search term.' })}</div>`;
        return;
      }
      results.innerHTML = tableCard(`
        <table class="min-w-full divide-y divide-slate-100">
          <caption class="sr-only">Fines ledger</caption>
          <thead class="bg-slate-50"><tr>
            <th scope="col" class="${C.th}">Member</th><th scope="col" class="${C.th}">Book</th>
            <th scope="col" class="${C.th} hidden md:table-cell">Returned</th><th scope="col" class="${C.th}">Days late</th>
            <th scope="col" class="${C.th} text-right">Amount</th><th scope="col" class="${C.th}">Status</th>
            <th scope="col" class="${C.th} hidden text-right sm:table-cell"><span class="sr-only">Actions</span></th>
          </tr></thead>
          <tbody class="divide-y divide-slate-100">
            ${fines.map((f) => `
              <tr class="hover:bg-slate-50/70" data-id="${f.id}">
                <td class="${C.td}">${highlight(f.member_name, q)}<br><span class="font-mono text-xs text-slate-500">${highlight(f.member_no, q)}</span></td>
                <td class="${C.td}">${highlight(f.title, q)}<br><span class="text-xs text-slate-500">due ${fmtDate(f.due_date)}</span></td>
                <td class="${C.td} hidden md:table-cell">${fmtDate(f.returned_at)}</td>
                <td class="${C.td}">${f.days_overdue}</td>
                <td class="${C.td} text-right font-semibold text-slate-900">${fmtZar(f.amount_zar)}</td>
                <td class="${C.td}">${badge(f.status[0].toUpperCase() + f.status.slice(1), TONE[f.status])}${f.settled_at ? `<br><span class="text-xs text-slate-500">${fmtDate(f.settled_at)}</span>` : ''}
                  ${f.status === 'unpaid' ? `<div class="mt-2 sm:hidden">${fineActions(f)}</div>` : ''}</td>
                <td class="${C.td} hidden text-right sm:table-cell">${f.status === 'unpaid' ? fineActions(f) : ''}</td>
              </tr>`).join('')}
          </tbody>
        </table>`);
    }

    results.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const fine = fines.find((f) => f.id === Number(btn.closest('tr').dataset.id));
      if (!fine) return;
      const pay = btn.dataset.act === 'pay';
      const ok = await confirmDialog({
        title: pay ? 'Record payment?' : 'Waive this fine?', confirmLabel: pay ? `Received ${fmtZar(fine.amount_zar)}` : 'Waive fine', danger: !pay,
        html: pay
          ? `<p>Confirm that <strong>${esc(fine.member_name)}</strong> has paid <strong>${fmtZar(fine.amount_zar)}</strong> for "${esc(fine.title)}".</p>`
          : `<p>The fine of <strong>${fmtZar(fine.amount_zar)}</strong> for ${esc(fine.member_name)} will be written off and no payment will be collected.</p><p class="mt-2 text-slate-500">This cannot be undone.</p>` });
      if (!ok) return;
      clearBanner(slot);
      try {
        const res = await withBusy(btn, 'Saving', () => api.post(`/api/fines/${fine.id}/settle`, { action: btn.dataset.act }));
        banner(slot, 'success', res.message, { title: pay ? 'Payment recorded' : 'Fine waived' });
        toast('success', pay ? 'Payment recorded.' : 'Fine waived.');
      } catch (err) {
        banner(slot, 'error', err.message, { title: 'Could not update fine' });
      }
      load();
    });

    $('[role=tablist]', el).addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b && b.dataset.tab !== tab) { setTab(b.dataset.tab); load(); }
    });
    $('[role=tablist]', el).addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const i = FILTERS.findIndex((t) => t.id === tab);
      setTab(FILTERS[(i + (e.key === 'ArrowRight' ? 1 : FILTERS.length - 1)) % FILTERS.length].id, true);
      load();
    });
    const debounced = debounce(load, 250);
    search.addEventListener('input', debounced);

    setTab('unpaid');
    await load();
    return () => { if (aborter) aborter.abort(); debounced.cancel(); };
  },
};
