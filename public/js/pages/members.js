// FR2 - Member registry: live search, create / edit / suspend / delete, password reset (staff only).
import { api } from '../api.js';
import { isAdmin } from '../state.js';
import { esc, C, highlight, debounce, badge, limitPips, fmtZar, fmtDate, icon, $, plural } from '../util.js';
import { openModal, confirmDialog, field, clearFieldErrors, showFieldErrors, formError, withBusy, toast, skeletonRows, emptyState, errorState } from '../ui.js';
import { pageHeader, tableCard } from '../page.js';

export default {
  title: 'Members',
  async render(el, { params }) {
    el.innerHTML = `
      ${pageHeader('Member registry', 'Register, update and manage library members.',
        `<button type="button" id="add-member" class="${C.btn}">${icon('plus')} Register member</button>`)}
      <div class="${C.card} mb-4 p-4">
        <div class="grid gap-3 md:grid-cols-[1fr_12rem]">
          <div>
            <label for="member-search" class="${C.label}">Search by name, member number or email</label>
            <div class="relative">
              <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">${icon('search', 'h-4 w-4')}</span>
              <input id="member-search" type="search" autocomplete="off" placeholder="e.g. Thandi, LUM-0003" class="${C.input} pl-9">
            </div>
          </div>
          <div>
            <label for="member-status" class="${C.label}">Status</label>
            <select id="member-status" class="${C.input}"><option value="">All members</option><option value="active">Active</option><option value="suspended">Suspended</option></select>
          </div>
        </div>
      </div>
      <p id="result-count" class="mb-2 text-sm text-slate-500" aria-live="polite">&nbsp;</p>
      <div id="results"></div>`;

    const search = $('#member-search', el);
    const status = $('#member-status', el);
    const results = $('#results', el);
    let aborter = null; let members = []; let max = 3;

    async function load() {
      if (aborter) aborter.abort();
      aborter = new AbortController();
      const q = search.value.trim();
      results.innerHTML = tableCard(`<table class="min-w-full"><tbody>${skeletonRows(5, 5)}</tbody></table>`);
      try {
        const res = await api.get('/api/members', { signal: aborter.signal, query: { q, status: status.value } });
        members = res.data; max = res.policy.max_active_loans;
        $('#result-count', el).textContent = `${plural(res.total, 'member')} found`;
        paint(q);
      } catch (err) {
        if (err.name === 'AbortError') return;
        results.innerHTML = `<div class="${C.card}">${errorState(err.message)}</div>`;
        $('[data-retry]', results).addEventListener('click', load);
      }
    }

    function paint(q) {
      if (!members.length) {
        results.innerHTML = `<div class="${C.card}">${emptyState({ iconName: 'users', title: 'No members match', message: 'Check the spelling or clear the filters.' })}</div>`;
        return;
      }
      results.innerHTML = tableCard(`
        <table class="min-w-full divide-y divide-slate-100">
          <caption class="sr-only">Registered members</caption>
          <thead class="bg-slate-50"><tr>
            <th scope="col" class="${C.th}">Member</th><th scope="col" class="${C.th} hidden md:table-cell">Contact</th>
            <th scope="col" class="${C.th}">Loans</th><th scope="col" class="${C.th} hidden sm:table-cell">Fines</th>
            <th scope="col" class="${C.th}">Status</th><th scope="col" class="${C.th} text-right">Actions</th>
          </tr></thead>
          <tbody class="divide-y divide-slate-100">
            ${members.map((m) => `
              <tr class="hover:bg-slate-50/70" data-id="${m.id}">
                <td class="${C.td}"><span class="font-medium text-slate-900">${highlight(`${m.first_name} ${m.last_name}`, q)}</span><br>
                  <span class="font-mono text-xs text-slate-500">${highlight(m.member_no, q)}</span></td>
                <td class="${C.td} hidden md:table-cell"><span class="text-slate-700">${highlight(m.email, q)}</span><br><span class="text-xs text-slate-500">${esc(m.phone || 'No phone')}</span></td>
                <td class="${C.td}"><div class="flex flex-col gap-1">${limitPips(m.active_loans, max)}
                  <span class="text-xs ${m.overdue_loans ? 'font-semibold text-red-700' : 'text-slate-500'}">${m.active_loans}/${max}${m.overdue_loans ? ` &middot; ${m.overdue_loans} overdue` : ''}</span></div></td>
                <td class="${C.td} hidden sm:table-cell ${m.unpaid_fines_zar ? 'font-semibold text-amber-700' : 'text-slate-400'}">${m.unpaid_fines_zar ? fmtZar(m.unpaid_fines_zar) : '-'}</td>
                <td class="${C.td}">${badge(m.status === 'active' ? 'Active' : 'Suspended', m.status === 'active' ? 'green' : 'red')}</td>
                <td class="${C.td} text-right"><div class="flex flex-wrap justify-end gap-1.5">
                  <button type="button" data-action="issue" class="${C.btnSmPrimary}" ${m.status !== 'active' ? 'disabled title="Member is suspended"' : ''}>Issue book</button>
                  <button type="button" data-action="edit" class="${C.btnSm}" aria-label="Edit ${esc(m.first_name)} ${esc(m.last_name)}">${icon('edit', 'h-4 w-4')}</button>
                  <button type="button" data-action="reset" class="${C.btnSm}" aria-label="Reset password for ${esc(m.first_name)} ${esc(m.last_name)}">${icon('key', 'h-4 w-4')}</button>
                  ${isAdmin() ? `<button type="button" data-action="delete" class="${C.btnSmDanger}" aria-label="Delete ${esc(m.first_name)} ${esc(m.last_name)}">${icon('trash', 'h-4 w-4')}</button>` : ''}
                </div></td>
              </tr>`).join('')}
          </tbody>
        </table>`);
    }

    const debounced = debounce(load, 250);
    search.addEventListener('input', debounced);
    status.addEventListener('change', load);

    results.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const m = members.find((x) => x.id === Number(btn.closest('tr').dataset.id));
      if (!m) return;
      const full = `${m.first_name} ${m.last_name}`;
      if (btn.dataset.action === 'issue') window.location.hash = `#/circulation?member=${m.id}`;
      if (btn.dataset.action === 'edit') memberForm(m);
      if (btn.dataset.action === 'reset') {
        const ok = await confirmDialog({ title: 'Reset password?', confirmLabel: 'Reset password',
          html: `<p>A new temporary password will be created for <strong>${esc(full)}</strong>. Their current password stops working immediately.</p>` });
        if (!ok) return;
        try {
          const res = await api.post(`/api/members/${m.id}/reset-password`);
          credentialsDialog(full, res.username, res.temporaryPassword);
        } catch (err) { toast('error', err.message, { title: 'Could not reset password' }); }
      }
      if (btn.dataset.action === 'delete') {
        const ok = await confirmDialog({ title: 'Delete this member?', danger: true, confirmLabel: 'Delete member',
          html: `<p><strong>${esc(full)}</strong> (${esc(m.member_no)}) and their login account will be permanently deleted.</p>
                 <p class="mt-2 text-slate-500">Members with loan or fine history cannot be deleted. Suspend them instead.</p>` });
        if (!ok) return;
        try { await api.del(`/api/members/${m.id}`); toast('success', `${full} was deleted.`); load(); }
        catch (err) { toast('error', err.message, { title: 'Could not delete member' }); }
      }
    });

    function credentialsDialog(name, username, password) {
      openModal({
        title: 'Sign-in details', size: 'sm',
        html: `
          <p class="text-sm text-slate-700">Give these details to <strong>${esc(name)}</strong>. The password is shown <strong>only once</strong>.</p>
          <dl class="mt-4 space-y-3 rounded-lg bg-slate-50 p-4 text-sm">
            <div><dt class="text-xs font-medium uppercase tracking-wide text-slate-500">Username</dt><dd class="font-mono text-base text-slate-900">${esc(username)}</dd></div>
            <div><dt class="text-xs font-medium uppercase tracking-wide text-slate-500">Temporary password</dt><dd class="select-all font-mono text-base text-slate-900">${esc(password)}</dd></div>
          </dl>
          <div class="mt-5 flex justify-end gap-2">
            <button type="button" data-copy class="${C.btnSecondary}">${icon('copy', 'h-4 w-4')} Copy</button>
            <button type="button" data-done class="${C.btn}" autofocus>Done</button>
          </div>`,
        onMount: (m) => {
          $('[data-done]', m.el).addEventListener('click', () => m.close());
          $('[data-copy]', m.el).addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(`Username: ${username}\nPassword: ${password}`); toast('success', 'Sign-in details copied.'); }
            catch { toast('info', 'Copy is not available here. Select the text and copy it manually.'); }
          });
        },
      });
    }

    function memberForm(member) {
      const editing = !!member;
      const m = member || {};
      openModal({
        title: editing ? `Edit ${m.first_name} ${m.last_name}` : 'Register a member',
        html: `
          <form id="member-form" class="grid gap-4" novalidate>
            <div data-form-error class="empty:hidden"></div>
            <div class="grid gap-4 sm:grid-cols-2">
              ${field({ name: 'first_name', label: 'First name', required: true, value: m.first_name, autofocus: true, autocomplete: 'off' })}
              ${field({ name: 'last_name', label: 'Last name', required: true, value: m.last_name })}
            </div>
            ${field({ name: 'email', label: 'Email', type: 'email', required: true, value: m.email, hint: 'Used to contact the member about overdue books.' })}
            ${field({ name: 'phone', label: 'Phone', type: 'tel', value: m.phone || '', hint: 'e.g. 082 123 4567' })}
            ${editing ? field({ name: 'status', label: 'Membership status', value: m.status, options: [
              { value: 'active', label: 'Active' }, { value: 'suspended', label: 'Suspended (cannot borrow)' }] }) : ''}
            ${editing ? '' : `<p class="rounded-lg bg-brand-50 p-3 text-sm text-brand-800">A member number and a temporary password are generated automatically when you save.</p>`}
            <div class="mt-1 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" data-cancel class="${C.btnSecondary}">Cancel</button>
              <button type="submit" class="${C.btn}">${editing ? 'Save changes' : 'Register member'}</button>
            </div>
          </form>`,
        onMount: (modal) => {
          const form = $('#member-form', modal.el);
          $('[data-cancel]', form).addEventListener('click', () => modal.close());
          form.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            clearFieldErrors(form);
            const data = Object.fromEntries(new FormData(form));
            if (data.phone === '') data.phone = editing ? null : undefined;
            try {
              const res = await withBusy($('button[type=submit]', form), 'Saving', () =>
                (editing ? api.put(`/api/members/${m.id}`, data) : api.post('/api/members', data)));
              modal.close();
              load();
              if (editing) toast('success', `${data.first_name} ${data.last_name} was updated.`);
              else credentialsDialog(`${data.first_name} ${data.last_name}`, res.account.username, res.account.temporaryPassword);
            } catch (err) {
              if (!(err.details?.length && showFieldErrors(form, err.details))) formError(form, err.message);
            }
          });
        },
      });
    }

    $('#add-member', el).addEventListener('click', () => memberForm());
    await load();
    if (params.new === '1') memberForm();
    return () => { if (aborter) aborter.abort(); debounced.cancel(); };
  },
};
