// UI kit: toasts, banners, modals, confirm dialogs, form helpers, combobox, skeletons.
import { esc, icon, C, $, $$, debounce } from './util.js';

// ------------------------------------------------------------------ colour tokens per message type
const TONE = {
  success: { box: 'border-emerald-300 bg-emerald-50 text-emerald-900', icon: 'check', ic: 'text-emerald-600' },
  error: { box: 'border-red-300 bg-red-50 text-red-900', icon: 'warn', ic: 'text-red-600' },
  warn: { box: 'border-amber-300 bg-amber-50 text-amber-900', icon: 'warn', ic: 'text-amber-600' },
  info: { box: 'border-sky-300 bg-sky-50 text-sky-900', icon: 'info', ic: 'text-sky-600' },
};

// ------------------------------------------------------------------ toasts (transient)
export function toast(type, message, { title, timeout } = {}) {
  const host = $('#toasts');
  if (!host) return;
  const tone = TONE[type] || TONE.info;
  const el = document.createElement('div');
  el.className = `pointer-events-auto pop-in flex gap-3 rounded-xl border p-3 shadow-lg ${tone.box}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `
    <span class="${tone.ic} mt-0.5">${icon(tone.icon)}</span>
    <div class="min-w-0 flex-1 text-sm">
      ${title ? `<p class="font-semibold">${esc(title)}</p>` : ''}
      <p class="break-words">${esc(message)}</p>
    </div>
    <button type="button" class="-m-1 h-7 w-7 shrink-0 rounded-md p-1 opacity-60 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-current" aria-label="Dismiss notification">${icon('x', 'h-5 w-5')}</button>`;
  const dismiss = () => el.remove();
  $('button', el).addEventListener('click', dismiss);
  host.appendChild(el);
  const ms = timeout ?? ({ success: 5000, info: 6000, warn: 9000, error: 10000 }[type] || 6000);
  if (ms > 0) setTimeout(dismiss, ms);
  while (host.children.length > 4) host.firstElementChild.remove();
}

// ------------------------------------------------------------------ banners (persistent, in-page)
export function banner(slot, type, message, { title } = {}) {
  if (!slot) return;
  const tone = TONE[type] || TONE.info;
  slot.innerHTML = `
    <div class="pop-in flex gap-3 rounded-xl border p-4 ${tone.box}" role="${type === 'error' || type === 'warn' ? 'alert' : 'status'}">
      <span class="${tone.ic} mt-0.5">${icon(tone.icon, 'h-6 w-6')}</span>
      <div class="min-w-0 flex-1 text-sm">
        ${title ? `<p class="text-base font-semibold">${esc(title)}</p>` : ''}
        <p class="break-words">${esc(message)}</p>
      </div>
      <button type="button" data-dismiss-banner class="-m-1 h-8 w-8 shrink-0 rounded-md p-1 opacity-60 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-current" aria-label="Dismiss message">${icon('x', 'h-5 w-5')}</button>
    </div>`;
  $('[data-dismiss-banner]', slot).addEventListener('click', () => { slot.innerHTML = ''; });
}
export const clearBanner = (slot) => { if (slot) slot.innerHTML = ''; };

// ------------------------------------------------------------------ modals
const modalStack = [];
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function openModal({ title, html, size = 'md', onMount }) {
  const root = $('#modal-root');
  const id = `modal-${Math.random().toString(36).slice(2, 8)}`;
  const width = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl' }[size];
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-slate-900/50 p-0 sm:items-center sm:p-4';
  overlay.innerHTML = `
    <div role="dialog" aria-modal="true" aria-labelledby="${id}-title"
         class="pop-in my-auto w-full ${width} rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl">
      <div class="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-4">
        <h2 id="${id}-title" class="text-lg font-semibold text-slate-900">${esc(title)}</h2>
        <button type="button" data-modal-close class="-m-1 rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" aria-label="Close dialog">${icon('x')}</button>
      </div>
      <div class="px-5 py-4" data-modal-body>${html}</div>
    </div>`;

  const previouslyFocused = document.activeElement;
  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  const dialog = $('[role=dialog]', overlay);

  const modal = {
    el: dialog,
    closed,
    close(result) {
      const i = modalStack.indexOf(modal);
      if (i < 0) return;
      modalStack.splice(i, 1);
      overlay.remove();
      if (!modalStack.length) document.body.style.overflow = '';
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
      resolveClosed(result);
    },
  };

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) modal.close(undefined); });
  $('[data-modal-close]', overlay).addEventListener('click', () => modal.close(undefined));
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); modal.close(undefined); return; }
    if (e.key !== 'Tab') return;
    const items = $$(FOCUSABLE, dialog).filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0]; const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  root.appendChild(overlay);
  modalStack.push(modal);
  document.body.style.overflow = 'hidden';
  if (onMount) onMount(modal);
  const initial = $('[autofocus]', dialog) || $('input:not([type=hidden]),select,textarea', dialog) || $('button:not([data-modal-close])', dialog) || dialog;
  if (initial === dialog) dialog.tabIndex = -1;
  initial.focus();
  return modal;
}

/** Resolves true if the user confirms, false otherwise. `html` is trusted markup (escape inputs!). */
export function confirmDialog({ title, html, confirmLabel = 'Confirm', danger = false, cancelLabel = 'Cancel' }) {
  const modal = openModal({
    title, size: 'sm',
    html: `
      <div class="text-sm text-slate-700">${html}</div>
      <div class="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" data-cancel class="${C.btnSecondary}">${esc(cancelLabel)}</button>
        <button type="button" data-ok class="${danger ? C.btnDanger : C.btn}" autofocus>${esc(confirmLabel)}</button>
      </div>`,
    onMount: (m) => {
      $('[data-cancel]', m.el).addEventListener('click', () => m.close(false));
      $('[data-ok]', m.el).addEventListener('click', () => m.close(true));
    },
  });
  return modal.closed.then((v) => v === true);
}

// ------------------------------------------------------------------ forms
export function field({ name, label, type = 'text', value = '', required = false, hint = '', options = null,
  autocomplete = 'off', attrs = '', autofocus = false }) {
  const id = `f-${name}`;
  const describedBy = `${hint ? `${id}-hint ` : ''}err-${name}`;
  const common = `id="${id}" name="${name}" ${required ? 'required' : ''} ${autofocus ? 'autofocus' : ''} aria-describedby="${describedBy}" autocomplete="${autocomplete}"`;
  let control;
  if (options) {
    control = `<select ${common} class="${C.input}">${options.map((o) =>
      `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  } else {
    control = `<input ${common} type="${type}" value="${esc(value)}" class="${C.input}" ${attrs}>`;
  }
  return `
    <div>
      <label for="${id}" class="${C.label}">${esc(label)}${required ? '<span class="text-red-600" aria-hidden="true"> *</span>' : ''}</label>
      ${control}
      ${hint ? `<p id="${id}-hint" class="mt-1 text-xs text-slate-500">${esc(hint)}</p>` : ''}
      <p id="err-${name}" data-error-for="${name}" class="mt-1 text-xs font-medium text-red-600"></p>
    </div>`;
}

export function clearFieldErrors(form) {
  $$('[data-error-for]', form).forEach((p) => { p.textContent = ''; });
  $$('[aria-invalid]', form).forEach((i) => i.removeAttribute('aria-invalid'));
  const fe = $('[data-form-error]', form);
  if (fe) fe.innerHTML = '';
}

/** Maps API validation details onto inputs. Returns true if at least one field was matched. */
export function showFieldErrors(form, details = []) {
  let first = null;
  for (const d of details) {
    const slot = $(`[data-error-for="${d.field}"]`, form);
    const input = $(`[name="${d.field}"]`, form);
    if (!slot || !input) continue;
    slot.textContent = d.message;
    input.setAttribute('aria-invalid', 'true');
    first = first || input;
  }
  if (first) first.focus();
  return !!first;
}

export function formError(form, message) {
  const slot = $('[data-form-error]', form);
  if (slot) banner(slot, 'error', message);
}

/** Disables a button and swaps its label while an async action runs. */
export async function withBusy(btn, label, fn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" opacity=".25"/><path d="M4 12a8 8 0 018-8" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg><span>${esc(label)}</span>`;
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = original; }
}

// ------------------------------------------------------------------ placeholders
export const skeletonRows = (rows = 5, cols = 5) => Array.from({ length: rows }, () =>
  `<tr>${Array.from({ length: cols }, () => '<td class="px-4 py-3"><div class="skeleton h-4 w-full"></div></td>').join('')}</tr>`).join('');

export const skeletonCards = (n = 4) => `<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">${Array.from({ length: n }, () =>
  `<div class="${C.card} p-5"><div class="skeleton mb-3 h-3 w-1/2"></div><div class="skeleton h-8 w-2/3"></div></div>`).join('')}</div>`;

export function emptyState({ iconName = 'search', title, message = '', actionHtml = '' }) {
  return `
    <div class="flex flex-col items-center px-6 py-12 text-center">
      <span class="mb-3 rounded-full bg-slate-100 p-3 text-slate-400">${icon(iconName, 'h-7 w-7')}</span>
      <p class="font-semibold text-slate-800">${esc(title)}</p>
      ${message ? `<p class="mt-1 max-w-sm text-sm text-slate-500">${esc(message)}</p>` : ''}
      ${actionHtml ? `<div class="mt-4">${actionHtml}</div>` : ''}
    </div>`;
}

export function errorState(message, retryLabel = 'Try again') {
  return `
    <div class="flex flex-col items-center px-6 py-12 text-center" role="alert">
      <span class="mb-3 rounded-full bg-red-50 p-3 text-red-500">${icon('warn', 'h-7 w-7')}</span>
      <p class="font-semibold text-slate-800">Something went wrong</p>
      <p class="mt-1 max-w-sm text-sm text-slate-500">${esc(message)}</p>
      <button type="button" data-retry class="${C.btnSecondary} mt-4">${esc(retryLabel)}</button>
    </div>`;
}

// ------------------------------------------------------------------ accessible combobox (live-search picker)
let comboSeq = 0;
/**
 * root must contain: input[data-cb-input] and ul[data-cb-list].
 * fetchItems(query, signal) -> Promise<Item[]>
 */
export function mountCombobox(root, { fetchItems, renderItem, getLabel, onSelect, onClear, emptyText = 'No matches', minChars = 0 }) {
  const input = $('[data-cb-input]', root);
  const list = $('[data-cb-list]', root);
  const listId = `cb-${++comboSeq}`;
  list.id = listId;
  list.setAttribute('role', 'listbox');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');

  let items = []; let active = -1; let selected = null; let aborter = null; let blurTimer = null; let seq = 0;

  const open = () => { list.classList.remove('hidden'); input.setAttribute('aria-expanded', 'true'); };
  const close = () => { list.classList.add('hidden'); input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };

  function paint(q) {
    if (!items.length) {
      list.innerHTML = `<li class="px-3 py-3 text-sm text-slate-500" role="presentation">${esc(emptyText)}</li>`;
      return;
    }
    list.innerHTML = items.map((it, i) => `
      <li id="${listId}-${i}" role="option" data-index="${i}" aria-selected="${i === active}"
          class="cursor-pointer border-b border-slate-100 px-3 py-2 last:border-0 ${i === active ? 'bg-brand-50' : 'hover:bg-slate-50'}">${renderItem(it, q)}</li>`).join('');
  }

  function setActive(i) {
    active = items.length ? (i + items.length) % items.length : -1;
    paint(input.value);
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `${listId}-${active}`);
      $(`#${listId}-${active}`, list)?.scrollIntoView({ block: 'nearest' });
    }
  }

  async function load(q) {
    if (aborter) aborter.abort();
    aborter = new AbortController();
    const mine = ++seq;
    list.innerHTML = '<li class="px-3 py-3 text-sm text-slate-500" role="presentation">Searching&hellip;</li>';
    open();
    try {
      const result = await fetchItems(q, aborter.signal);
      if (mine !== seq) return;
      items = result; active = -1; paint(q);
    } catch (err) {
      if (err.name === 'AbortError') return;
      list.innerHTML = `<li class="px-3 py-3 text-sm text-red-600" role="presentation">${esc(err.message)}</li>`;
    }
  }
  const debouncedLoad = debounce(load, 200);

  function choose(item) {
    selected = item;
    input.value = getLabel(item);
    close();
    onSelect(item);
  }

  input.addEventListener('input', () => {
    if (selected) { selected = null; onClear && onClear(); }
    const q = input.value.trim();
    if (q.length < minChars) { debouncedLoad.cancel(); items = []; close(); return; }
    debouncedLoad(q);
  });
  input.addEventListener('focus', () => {
    clearTimeout(blurTimer);
    if (!selected && input.value.trim().length >= minChars) load(input.value.trim());
  });
  input.addEventListener('blur', () => { blurTimer = setTimeout(close, 150); });
  input.addEventListener('keydown', (e) => {
    const isOpen = !list.classList.contains('hidden');
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!isOpen) { load(input.value.trim()); return; } setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (isOpen) setActive(active - 1); }
    else if (e.key === 'Enter' && isOpen && active >= 0) { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape' && isOpen) { e.stopPropagation(); close(); }
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('[data-index]');
    if (!li) return;
    e.preventDefault();               // keep focus in the input
    choose(items[Number(li.dataset.index)]);
  });

  return {
    select: (item) => { selected = item; input.value = getLabel(item); close(); onSelect(item); },
    clear: () => { selected = null; input.value = ''; close(); onClear && onClear(); },
    get selected() { return selected; },
    focus: () => input.focus(),
  };
}
