// FR6 - Weekly financial & overdue report: on-screen, CSV export and print / save-as-PDF.
import { api } from '../api.js';
import { state } from '../state.js';
import { esc, C, fmtZar, fmtDate, plural, badge, icon, $ } from '../util.js';
import { toast, withBusy, skeletonCards, emptyState, errorState } from '../ui.js';
import { pageHeader, statCard, tableCard } from '../page.js';

/** 'YYYY-MM-DD' + n days, without timezone drift. */
function addDays(s, n) {
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
}

export default {
  title: 'Reports',
  async render(el, { params }) {
    const defaultStart = addDays(state.today, -6);
    let weekStart = /^\d{4}-\d{2}-\d{2}$/.test(params.week_start || '') ? params.week_start : defaultStart;
    let report = null;
    let aborter = null;

    el.innerHTML = `
      ${pageHeader('Weekly report', 'Circulation, fines collected and overdue books for a seven-day period.',
        `<button type="button" id="print-btn" class="${C.btnSecondary}">${icon('print', 'h-4 w-4')} Print / PDF</button>
         <button type="button" id="csv-btn" class="${C.btn}">${icon('download', 'h-4 w-4')} Download CSV</button>`)}
      <div class="${C.card} no-print mb-5 flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
        <div>
          <label for="week-start" class="${C.label}">Week starting</label>
          <input id="week-start" type="date" max="${state.today}" value="${weekStart}" class="${C.input} sm:w-48">
        </div>
        <div class="flex gap-2">
          <button type="button" id="prev-week" class="${C.btnSecondary}" aria-label="Previous week">&larr; Previous</button>
          <button type="button" id="next-week" class="${C.btnSecondary}" aria-label="Next week">Next &rarr;</button>
          <button type="button" id="this-week" class="${C.btnSecondary}">Last 7 days</button>
        </div>
      </div>
      <div id="report-body">${skeletonCards(4)}</div>`;

    const body = $('#report-body', el);
    const picker = $('#week-start', el);

    async function load() {
      if (aborter) aborter.abort();
      aborter = new AbortController();
      picker.value = weekStart;
      body.innerHTML = skeletonCards(4);
      try {
        report = await api.get('/api/reports/weekly', { signal: aborter.signal, query: { week_start: weekStart } });
        paint();
      } catch (err) {
        if (err.name === 'AbortError') return;
        body.innerHTML = `<div class="${C.card}">${errorState(err.message)}</div>`;
        $('[data-retry]', body).addEventListener('click', load);
      }
    }

    function paint() {
      const t = report.totals;
      const maxN = Math.max(1, ...report.daily.map((d) => Math.max(d.loans_issued, d.returns_processed)));
      body.innerHTML = `
        <p class="mb-4 text-sm text-slate-600">Period: <strong>${fmtDate(report.period.start)}</strong> to <strong>${fmtDate(report.period.end)}</strong></p>
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          ${statCard({ label: 'Loans issued', value: t.loans_issued, sub: `${t.returns_processed} returned`, iconName: 'swap' })}
          ${statCard({ label: 'Fines assessed', value: fmtZar(t.fines_assessed_zar), sub: plural(t.fines_assessed_count, 'fine'), tone: t.fines_assessed_zar ? 'amber' : 'green', iconName: 'cash' })}
          ${statCard({ label: 'Fines collected', value: fmtZar(t.fines_collected_zar), sub: `${fmtZar(t.fines_waived_zar)} waived`, tone: 'green', iconName: 'check' })}
          ${statCard({ label: 'Outstanding fines', value: fmtZar(t.outstanding_fines_zar), sub: `${plural(t.outstanding_fines_count, 'fine')} unpaid (all time)`, tone: t.outstanding_fines_count ? 'red' : 'green', iconName: 'warn' })}
        </div>

        <section class="${C.card} mt-6 p-5" aria-labelledby="daily-h">
          <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 id="daily-h" class="font-semibold text-slate-900">Daily activity</h2>
            <div class="flex items-center gap-4 text-xs text-slate-600" aria-hidden="true">
              <span class="flex items-center gap-1.5"><span class="h-3 w-3 rounded-sm bg-brand-600"></span>Issued</span>
              <span class="flex items-center gap-1.5"><span class="h-3 w-3 rounded-sm bg-amber-400"></span>Returned</span>
            </div>
          </div>
          <div class="grid grid-cols-7 items-end gap-2 sm:gap-4" role="img" aria-label="Bar chart of loans issued and returned per day. Exact values are in the table below.">
            ${report.daily.map((d) => `
              <div class="flex flex-col items-center gap-1">
                <div class="flex h-32 w-full items-end justify-center gap-1">
                  <div class="flex w-1/2 max-w-[1.5rem] flex-col items-center justify-end" style="height:100%"><span class="mb-0.5 text-[11px] font-semibold text-slate-700">${d.loans_issued || ''}</span>
                    <div class="w-full rounded-t bg-brand-600" style="height:${Math.round((d.loans_issued / maxN) * 100)}%;min-height:${d.loans_issued ? 4 : 0}px"></div></div>
                  <div class="flex w-1/2 max-w-[1.5rem] flex-col items-center justify-end" style="height:100%"><span class="mb-0.5 text-[11px] font-semibold text-slate-700">${d.returns_processed || ''}</span>
                    <div class="w-full rounded-t bg-amber-400" style="height:${Math.round((d.returns_processed / maxN) * 100)}%;min-height:${d.returns_processed ? 4 : 0}px"></div></div>
                </div>
                <span class="text-xs font-medium text-slate-600">${esc(d.weekday)}</span>
              </div>`).join('')}
          </div>
          <div class="mt-4">${tableCard(`
            <table class="min-w-full divide-y divide-slate-100 text-sm">
              <caption class="sr-only">Daily breakdown of circulation and fines</caption>
              <thead class="bg-slate-50"><tr><th scope="col" class="${C.th}">Date</th><th scope="col" class="${C.th} text-right">Issued</th><th scope="col" class="${C.th} text-right">Returned</th>
                <th scope="col" class="${C.th} text-right">Fines assessed</th><th scope="col" class="${C.th} text-right">Fines collected</th></tr></thead>
              <tbody class="divide-y divide-slate-100">${report.daily.map((d) => `
                <tr><th scope="row" class="${C.td} text-left font-medium">${esc(d.weekday)} ${fmtDate(d.date)}</th><td class="${C.td} text-right">${d.loans_issued}</td><td class="${C.td} text-right">${d.returns_processed}</td>
                  <td class="${C.td} text-right">${fmtZar(d.fines_assessed_zar)}</td><td class="${C.td} text-right">${fmtZar(d.fines_collected_zar)}</td></tr>`).join('')}</tbody>
              <tfoot class="bg-slate-50 font-semibold"><tr><th scope="row" class="${C.td} text-left">Total</th><td class="${C.td} text-right">${t.loans_issued}</td><td class="${C.td} text-right">${t.returns_processed}</td>
                <td class="${C.td} text-right">${fmtZar(t.fines_assessed_zar)}</td><td class="${C.td} text-right">${fmtZar(t.fines_collected_zar)}</td></tr></tfoot>
            </table>`, 'shadow-none')}</div>
        </section>

        <div class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <section class="${C.card} min-w-0 overflow-hidden lg:col-span-2" aria-labelledby="od-h">
            <div class="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h2 id="od-h" class="font-semibold text-slate-900">Overdue books (as of today)</h2>
              ${badge(`${t.overdue_loans} overdue · ${fmtZar(t.overdue_projected_fines_zar)}`, t.overdue_loans ? 'red' : 'green')}
            </div>
            ${report.overdue.length ? `<div class="relative overflow-x-auto"><table class="min-w-full divide-y divide-slate-100">
              <caption class="sr-only">Overdue loans, longest overdue first</caption>
              <thead class="bg-slate-50"><tr><th scope="col" class="${C.th}">Member</th><th scope="col" class="${C.th}">Book</th><th scope="col" class="${C.th}">Due</th>
                <th scope="col" class="${C.th} text-right">Days</th><th scope="col" class="${C.th} text-right">Fine so far</th></tr></thead>
              <tbody class="divide-y divide-slate-100">${report.overdue.map((o) => `
                <tr><td class="${C.td}">${esc(o.member_name)}<br><span class="font-mono text-xs text-slate-500">${esc(o.member_no)}</span></td>
                  <td class="${C.td}">${esc(o.title)}</td><td class="${C.td}">${fmtDate(o.due_date)}</td>
                  <td class="${C.td} text-right font-medium text-red-700">${o.days_overdue}</td><td class="${C.td} text-right font-medium">${fmtZar(o.projected_fine_zar)}</td></tr>`).join('')}</tbody>
            </table></div>` : emptyState({ iconName: 'check', title: 'Nothing overdue', message: 'All borrowed books are within their loan period.' })}
          </section>
          <section class="${C.card} p-5" aria-labelledby="top-h">
            <h2 id="top-h" class="mb-3 font-semibold text-slate-900">Most borrowed this week</h2>
            ${report.top_books.length ? `<ol class="divide-y divide-slate-100 text-sm">${report.top_books.map((b, i) => `
              <li class="flex items-start gap-3 py-2.5"><span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-50 text-xs font-bold text-brand-700">${i + 1}</span>
                <span class="min-w-0 flex-1"><span class="block truncate font-medium text-slate-900">${esc(b.title)}</span><span class="block truncate text-xs text-slate-500">${esc(b.author)}</span></span>
                <span class="shrink-0 text-xs text-slate-600">${plural(b.loans, 'loan')}</span></li>`).join('')}</ol>`
              : '<p class="text-sm text-slate-500">No loans were issued in this period.</p>'}
          </section>
        </div>`;
    }

    function setWeek(s) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return;
      weekStart = s;
      load();
    }
    picker.addEventListener('change', () => setWeek(picker.value));
    $('#prev-week', el).addEventListener('click', () => setWeek(addDays(weekStart, -7)));
    $('#next-week', el).addEventListener('click', () => setWeek(addDays(weekStart, 7)));
    $('#this-week', el).addEventListener('click', () => setWeek(defaultStart));
    $('#print-btn', el).addEventListener('click', () => window.print());
    $('#csv-btn', el).addEventListener('click', (e) => withBusy(e.currentTarget, 'Preparing', async () => {
      try {
        const blob = await api.get('/api/reports/weekly.csv', { query: { week_start: weekStart }, blob: true });
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement('a'), { href: url, download: `lumina-weekly-report-${weekStart}.csv` });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast('success', 'Report downloaded. Open it in Excel or Google Sheets.');
      } catch (err) { toast('error', err.message, { title: 'Download failed' }); }
    }));

    await load();
    return () => { if (aborter) aborter.abort(); };
  },
};
