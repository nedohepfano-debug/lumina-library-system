// Page-level building blocks shared by all screens.
import { esc, icon, C } from './util.js';

export function pageHeader(title, subtitle = '', actionsHtml = '') {
  return `
    <div class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div class="min-w-0">
        <h1 id="page-title" tabindex="-1" class="${C.pageTitle} focus:outline-none">${esc(title)}</h1>
        ${subtitle ? `<p class="mt-1 text-sm text-slate-500">${esc(subtitle)}</p>` : ''}
      </div>
      ${actionsHtml ? `<div class="no-print flex flex-wrap gap-2">${actionsHtml}</div>` : ''}
    </div>`;
}

const TONES = {
  default: 'bg-brand-50 text-brand-700',
  red: 'bg-red-50 text-red-600',
  amber: 'bg-amber-50 text-amber-600',
  green: 'bg-emerald-50 text-emerald-600',
  slate: 'bg-slate-100 text-slate-600',
};

export function statCard({ label, value, sub = '', tone = 'default', iconName = 'book', href = '' }) {
  const body = `
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-sm font-medium text-slate-500">${esc(label)}</p>
        <p class="mt-1 truncate text-3xl font-bold tracking-tight text-slate-900">${esc(value)}</p>
        ${sub ? `<p class="mt-1 text-xs text-slate-500">${esc(sub)}</p>` : ''}
      </div>
      <span class="rounded-lg p-2 ${TONES[tone] || TONES.default}">${icon(iconName, 'h-6 w-6')}</span>
    </div>`;
  return href
    ? `<a href="${esc(href)}" class="${C.card} block p-5 transition hover:border-brand-300 hover:shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">${body}</a>`
    : `<div class="${C.card} p-5">${body}</div>`;
}

/** Wraps table markup in a horizontally scrollable card. */
export const tableCard = (inner, extra = '') => `
  <div class="${C.card} relative overflow-hidden ${extra}">
    <div class="overflow-x-auto">${inner}</div>
  </div>`;

export function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
