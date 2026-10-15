// Role-based dashboards: staff overview vs. member self-service (FR1 role separation, FR4/FR5 visibility).
import { api } from '../api.js';
import { state } from '../state.js';
import { esc, C, fmtZar, fmtDate, plural, badge, loanBadge, limitPips, icon, $ } from '../util.js';
import { skeletonCards, emptyState, errorState, banner } from '../ui.js';
import { pageHeader, statCard, tableCard, greeting } from '../page.js';

export default {
  title: 'Dashboard',
  render(el) {
    return state.user.role === 'member' ? renderMember(el) : renderStaff(el);
  },
};

// ---------------------------------------------------------------- staff
async function renderStaff(el) {
  const name = state.user.username;
  el.innerHTML = `
    ${pageHeader(`${greeting()}, ${name}`, 'Here is what is happening at the library right now.')}
    <div id="stats">${skeletonCards(5)}</div>
    <div class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
      <section class="${C.card} min-w-0 overflow-hidden lg:col-span-2" aria-labelledby="overdue-h">
        <div class="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 id="overdue-h" class="font-semibold text-slate-900">Overdue loans</h2>
          <a href="#/circulation" class="text-sm font-medium text-brand-700 hover:underline">Go to circulation</a>
        </div>
        <div id="overdue-list" class="p-2"><div class="skeleton m-3 h-4 w-2/3"></div><div class="skeleton m-3 h-4 w-1/2"></div></div>
      </section>
      <section class="${C.card} p-5" aria-labelledby="qa-h">
        <h2 id="qa-h" class="mb-3 font-semibold text-slate-900">Quick actions</h2>
        <div class="grid gap-2">
          <a href="#/circulation" class="${C.btn} justify-start">${icon('swap')} Issue or return a book</a>
          <a href="#/members?new=1" class="${C.btnSecondary} justify-start">${icon('users')} Register a member</a>
          <a href="#/catalog?new=1" class="${C.btnSecondary} justify-start">${icon('book')} Add a book</a>
          <a href="#/reports" class="${C.btnSecondary} justify-start">${icon('chart')} Weekly report</a>
        </div>
      </section>
    </div>`;

  try {
    const [s, overdue] = await Promise.all([
      api.get('/api/reports/summary'),
      api.get('/api/loans', { query: { status: 'overdue', limit: 6 } }),
    ]);
    $('#stats', el).innerHTML = `
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        ${statCard({ label: 'Active loans', value: s.loans.active, sub: `${s.loans.issued_today} issued today`, iconName: 'swap', href: '#/circulation' })}
        ${statCard({ label: 'Overdue', value: s.loans.overdue, sub: s.loans.overdue ? 'Needs follow-up' : 'All on time', tone: s.loans.overdue ? 'red' : 'green', iconName: 'warn', href: '#/circulation' })}
        ${statCard({ label: 'Unpaid fines', value: fmtZar(s.fines.unpaid_zar), sub: plural(s.fines.unpaid_count, 'fine'), tone: s.fines.unpaid_count ? 'amber' : 'green', iconName: 'cash', href: '#/fines' })}
        ${statCard({ label: 'Copies in', value: `${s.books.available}/${s.books.copies}`, sub: plural(s.books.titles, 'title'), iconName: 'book', href: '#/catalog' })}
        ${statCard({ label: 'Members', value: s.members.active, sub: `${s.members.suspended || 0} suspended`, iconName: 'users', href: '#/members' })}
      </div>`;

    $('#overdue-list', el).innerHTML = overdue.data.length ? tableCard(`
      <table class="min-w-full divide-y divide-slate-100">
        <caption class="sr-only">Overdue loans, most urgent first</caption>
        <thead><tr><th scope="col" class="${C.th}">Book</th><th scope="col" class="${C.th}">Member</th><th scope="col" class="${C.th}">Overdue</th><th scope="col" class="${C.th} text-right">Fine so far</th></tr></thead>
        <tbody class="divide-y divide-slate-100">
          ${overdue.data.map((l) => `
            <tr>
              <td class="${C.td}"><span class="font-medium text-slate-900">${esc(l.title)}</span><br><span class="text-xs text-slate-500">due ${fmtDate(l.due_date)}</span></td>
              <td class="${C.td}">${esc(l.member_name)}<br><span class="text-xs text-slate-500">${esc(l.member_no)}</span></td>
              <td class="${C.td}">${loanBadge(l, state.today)}</td>
              <td class="${C.td} text-right font-medium text-red-700">${fmtZar(l.projected_fine_zar)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`, 'border-0 shadow-none')
      : emptyState({ iconName: 'check', title: 'Nothing overdue', message: 'Every borrowed book is within its loan period.' });
  } catch (err) {
    $('#stats', el).innerHTML = errorState(err.message);
    $('#overdue-list', el).innerHTML = '';
    $('[data-retry]', el)?.addEventListener('click', () => renderStaff(el));
  }
}

// ---------------------------------------------------------------- member
async function renderMember(el) {
  const memberId = state.user.member.id;
  el.innerHTML = `
    ${pageHeader(`${greeting()}, ${state.user.member.name.split(' ')[0]}`,
      `Member ${state.user.member.member_no}. Here are your loans and fines.`)}
    <div id="m-banner" class="mb-4 empty:hidden"></div>
    <div id="m-body">${skeletonCards(3)}</div>`;

  try {
    const [profile, active, history, fines] = await Promise.all([
      api.get(`/api/members/${memberId}`),
      api.get('/api/loans', { query: { status: 'active' } }),
      api.get('/api/loans', { query: { status: 'returned', limit: 10 } }),
      api.get('/api/fines'),
    ]);
    const m = profile.member;
    const max = profile.policy.max_active_loans;
    const rate = active.policy.fine_per_day_zar;
    const atLimit = m.active_loans >= max;

    if (m.status === 'suspended') {
      banner($('#m-banner', el), 'error', 'Your membership is currently suspended, so new loans cannot be issued. Please speak to a librarian.', { title: 'Account suspended' });
    } else if (m.overdue_loans > 0) {
      banner($('#m-banner', el), 'warn',
        `You have ${plural(m.overdue_loans, 'overdue book')}. Fines build up at ${fmtZar(rate)} per day, so please return ${m.overdue_loans === 1 ? 'it' : 'them'} soon.`,
        { title: 'Please return overdue books' });
    }

    $('#m-body', el).innerHTML = `
      <div class="grid gap-4 sm:grid-cols-3">
        <div class="${C.card} p-5">
          <p class="text-sm font-medium text-slate-500">Borrowing slots used</p>
          <p class="mt-1 text-3xl font-bold text-slate-900">${m.active_loans} <span class="text-lg font-medium text-slate-400">of ${max}</span></p>
          <div class="mt-2 flex items-center gap-2">${limitPips(m.active_loans, max)}
            <span class="text-xs ${atLimit ? 'font-semibold text-red-700' : 'text-slate-500'}">${atLimit ? 'Limit reached' : `${plural(max - m.active_loans, 'slot')} free`}</span></div>
        </div>
        ${statCard({ label: 'Overdue books', value: m.overdue_loans, tone: m.overdue_loans ? 'red' : 'green', iconName: 'warn' })}
        ${statCard({ label: 'Unpaid fines', value: fmtZar(m.unpaid_fines_zar), tone: m.unpaid_fines_zar ? 'amber' : 'green', iconName: 'cash', sub: 'Pay at the library desk' })}
      </div>

      <section class="mt-6" aria-labelledby="my-loans-h">
        <h2 id="my-loans-h" class="mb-3 text-lg font-semibold text-slate-900">Books on loan</h2>
        ${active.data.length ? `<div class="grid gap-3 md:grid-cols-2 lg:grid-cols-3">${active.data.map((l) => `
          <article class="${C.card} p-4 ${l.is_overdue ? 'border-red-300' : ''}">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0"><h3 class="truncate font-semibold text-slate-900">${esc(l.title)}</h3>
                <p class="truncate text-sm text-slate-500">${esc(l.author)}</p></div>
              ${loanBadge(l, state.today)}
            </div>
            <p class="mt-3 text-xs text-slate-500">Borrowed ${fmtDate(l.borrowed_at)} &middot; due <strong class="text-slate-700">${fmtDate(l.due_date)}</strong></p>
            ${l.is_overdue ? `<p class="mt-1 text-xs font-semibold text-red-700">Fine so far: ${fmtZar(l.projected_fine_zar)}</p>` : ''}
          </article>`).join('')}</div>`
          : `<div class="${C.card}">${emptyState({ iconName: 'book', title: 'No books on loan', message: 'Browse the catalogue to find your next read.', actionHtml: `<a href="#/catalog" class="${C.btn}">Browse catalogue</a>` })}</div>`}
      </section>

      <section class="mt-8" aria-labelledby="my-fines-h">
        <h2 id="my-fines-h" class="mb-3 text-lg font-semibold text-slate-900">Fines</h2>
        ${fines.data.length ? tableCard(`
          <table class="min-w-full divide-y divide-slate-100">
            <caption class="sr-only">Your fines</caption>
            <thead><tr><th scope="col" class="${C.th}">Book</th><th scope="col" class="${C.th}">Returned</th><th scope="col" class="${C.th}">Days late</th><th scope="col" class="${C.th} text-right">Amount</th><th scope="col" class="${C.th}">Status</th></tr></thead>
            <tbody class="divide-y divide-slate-100">${fines.data.map((f) => `
              <tr><td class="${C.td} font-medium text-slate-900">${esc(f.title)}</td><td class="${C.td}">${fmtDate(f.returned_at)}</td>
                <td class="${C.td}">${f.days_overdue}</td><td class="${C.td} text-right font-medium">${fmtZar(f.amount_zar)}</td>
                <td class="${C.td}">${badge(f.status, f.status === 'unpaid' ? 'amber' : f.status === 'paid' ? 'green' : 'slate')}</td></tr>`).join('')}</tbody>
          </table>`) : `<div class="${C.card}">${emptyState({ iconName: 'check', title: 'No fines', message: 'Keep returning books on time and it will stay that way.' })}</div>`}
      </section>

      <details class="mt-8 ${C.card} p-5">
        <summary class="cursor-pointer font-semibold text-slate-900">Recently returned (${history.data.length})</summary>
        ${history.data.length ? `<ul class="mt-3 divide-y divide-slate-100 text-sm">${history.data.map((l) => `
          <li class="flex justify-between gap-3 py-2"><span class="truncate">${esc(l.title)}</span><span class="shrink-0 text-slate-500">${fmtDate(l.returned_at)}</span></li>`).join('')}</ul>`
          : '<p class="mt-3 text-sm text-slate-500">No returned books yet.</p>'}
      </details>`;
  } catch (err) {
    $('#m-body', el).innerHTML = errorState(err.message);
    $('[data-retry]', el)?.addEventListener('click', () => renderMember(el));
  }
}
