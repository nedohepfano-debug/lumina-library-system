// Application shell: session bootstrap, sign-in screen, role-based navigation and the hash router.
//   FR1  Secure access  -> sign-in, session expiry handling, change password, role-gated routes
import { api, setUnauthorizedHandler } from './api.js';
import { state, isStaff } from './state.js';
import { esc, icon, C, $, $$ } from './util.js';
import { toast, banner, openModal, field, clearFieldErrors, showFieldErrors, formError, withBusy } from './ui.js';

// ---------------------------------------------------------------- routes (path -> module, allowed roles)
const ROUTES = {
  dashboard: { load: () => import('./pages/dashboard.js'), nav: 'Dashboard', icon: 'home', roles: ['admin', 'librarian', 'member'] },
  circulation: { load: () => import('./pages/circulation.js'), nav: 'Circulation', icon: 'swap', roles: ['admin', 'librarian'] },
  catalog: { load: () => import('./pages/catalog.js'), nav: 'Catalogue', icon: 'book', roles: ['admin', 'librarian', 'member'] },
  members: { load: () => import('./pages/members.js'), nav: 'Members', icon: 'users', roles: ['admin', 'librarian'] },
  fines: { load: () => import('./pages/fines.js'), nav: 'Fines', icon: 'cash', roles: ['admin', 'librarian'] },
  reports: { load: () => import('./pages/reports.js'), nav: 'Reports', icon: 'chart', roles: ['admin', 'librarian'] },
};
const ROLE_LABEL = { admin: 'Administrator', librarian: 'Librarian', member: 'Member' };

const appEl = $('#app');
let cleanup = null;      // teardown function returned by the current page
let navSeq = 0;          // guards against out-of-order async renders

// ---------------------------------------------------------------- hash routing helpers
function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  return { path: path || 'dashboard', params: Object.fromEntries(new URLSearchParams(qs)) };
}

// ---------------------------------------------------------------- sign-in screen (FR1)
function showLogin(notice) {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  state.user = null;
  document.title = 'Sign in | Lumina Library';
  appEl.setAttribute('aria-busy', 'false');
  appEl.innerHTML = `
    <main id="main" class="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10">
      <div class="mb-6 text-center">
        <span class="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-brand-700 text-amber-300">${icon('book', 'h-8 w-8')}</span>
        <h1 class="text-2xl font-bold tracking-tight text-slate-900">Lumina Library</h1>
        <p class="mt-1 text-sm text-slate-500">Makhanda community library &middot; sign in to continue</p>
      </div>
      <div id="login-notice" class="mb-4 empty:hidden"></div>
      <form id="login-form" class="${C.card} grid gap-4 p-6" novalidate>
        <div data-form-error class="empty:hidden"></div>
        ${field({ name: 'username', label: 'Username or member number', required: true, autofocus: true, autocomplete: 'username', hint: 'Members: your number looks like LUM-0001.', attrs: 'autocapitalize="off" spellcheck="false"' })}
        <div>
          <label for="f-password" class="${C.label}">Password<span class="text-red-600" aria-hidden="true"> *</span></label>
          <div class="relative">
            <input id="f-password" name="password" type="password" required autocomplete="current-password" aria-describedby="err-password" class="${C.input} pr-16">
            <button type="button" id="toggle-pw" class="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" aria-pressed="false">Show</button>
          </div>
          <p id="err-password" data-error-for="password" class="mt-1 text-xs font-medium text-red-600"></p>
        </div>
        <button type="submit" class="${C.btn} w-full">Sign in</button>
      </form>
      <div id="demo-box" class="mt-5"></div>
    </main>`;
  if (notice) banner($('#login-notice'), notice.type, notice.message);

  const form = $('#login-form');
  const pw = $('#f-password');
  $('#toggle-pw').addEventListener('click', (e) => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Hide' : 'Show';
    e.currentTarget.setAttribute('aria-pressed', String(show));
  });

  async function submit(username, password) {
    clearFieldErrors(form);
    $('#login-notice').innerHTML = '';
    if (!username) { showFieldErrors(form, [{ field: 'username', message: 'Enter your username.' }]); return; }
    if (!password) { showFieldErrors(form, [{ field: 'password', message: 'Enter your password.' }]); return; }
    try {
      const res = await withBusy($('button[type=submit]', form), 'Signing in', () =>
        api.post('/api/auth/login', { username, password }));
      state.user = res.user;
      if (!window.location.hash || window.location.hash === '#/login') window.location.hash = '#/dashboard';
      startShell();
      toast('success', `Signed in as ${res.user.member ? res.user.member.name : res.user.username}.`);
    } catch (err) {
      if (err.details?.length && showFieldErrors(form, err.details)) return;
      formError(form, err.message);
      pw.value = '';
      pw.focus();
    }
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(form.username.value.trim(), form.password.value);
  });

  // Demo shortcuts (shown only when the server runs with DEMO_MODE on).
  if (state.demo && state.demoAccounts.length) {
    $('#demo-box').innerHTML = `
      <div class="rounded-xl border border-dashed border-slate-300 bg-white/60 p-4">
        <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Demo accounts &mdash; click to sign in</p>
        <div class="grid gap-2 sm:grid-cols-2">
          ${state.demoAccounts.map((a, i) => `
            <button type="button" data-demo="${i}" class="${C.btnSecondary} !justify-start !px-3 !py-2 text-left">
              <span class="min-w-0"><span class="block text-sm leading-tight">${esc(a.role)}</span>
              <span class="block truncate font-mono text-xs font-normal text-slate-500">${esc(a.username)}</span></span>
            </button>`).join('')}
        </div>
      </div>`;
    $('#demo-box').addEventListener('click', (e) => {
      const b = e.target.closest('[data-demo]');
      if (!b) return;
      const a = state.demoAccounts[Number(b.dataset.demo)];
      form.username.value = a.username;
      form.password.value = a.password;
      submit(a.username, a.password);
    });
  }
}

// ---------------------------------------------------------------- change password (FR1)
function passwordDialog() {
  openModal({
    title: 'Change password',
    size: 'sm',
    html: `
      <form id="pw-form" class="grid gap-4" novalidate>
        <div data-form-error class="empty:hidden"></div>
        ${field({ name: 'current_password', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password', autofocus: true })}
        ${field({ name: 'new_password', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', hint: '8-72 characters with at least one letter and one number.' })}
        <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" data-cancel class="${C.btnSecondary}">Cancel</button>
          <button type="submit" class="${C.btn}">Update password</button>
        </div>
      </form>`,
    onMount: (m) => {
      const form = $('#pw-form', m.el);
      $('[data-cancel]', form).addEventListener('click', () => m.close());
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearFieldErrors(form);
        try {
          await withBusy($('button[type=submit]', form), 'Saving', () => api.post('/api/auth/change-password', {
            current_password: form.current_password.value, new_password: form.new_password.value,
          }));
          m.close();
          toast('success', 'Your password was updated.');
        } catch (err) {
          if (!(err.details?.length && showFieldErrors(form, err.details))) formError(form, err.message);
        }
      });
    },
  });
}

// ---------------------------------------------------------------- shell (header + nav + main)
function startShell() {
  const u = state.user;
  const items = Object.entries(ROUTES).filter(([, r]) => r.roles.includes(u.role));
  const who = u.member ? u.member.name : u.username;
  appEl.setAttribute('aria-busy', 'false');
  appEl.innerHTML = `
    <header class="no-print sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div class="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4">
        <button type="button" id="menu-btn" class="rounded-lg p-2 text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 md:hidden" aria-label="Open menu" aria-expanded="false" aria-controls="nav">${icon('menu', 'h-6 w-6')}</button>
        <a href="#/dashboard" class="flex items-center gap-2 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
          <span class="grid h-9 w-9 place-items-center rounded-xl bg-brand-700 text-amber-300">${icon('book', 'h-5 w-5')}</span>
          <span class="hidden text-lg font-bold tracking-tight text-slate-900 sm:block">Lumina Library</span>
        </a>
        <nav id="nav" aria-label="Main" class="hidden flex-1 md:block">
          <ul class="flex items-center gap-1">${items.map(([path, r]) => `
            <li><a href="#/${path}" data-nav="${path}" class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 aria-[current=page]:bg-brand-50 aria-[current=page]:text-brand-800">${icon(r.icon, 'h-4 w-4')}${esc(r.nav)}</a></li>`).join('')}
          </ul>
        </nav>
        <div class="ml-auto flex items-center gap-2">
          <div class="hidden text-right leading-tight sm:block">
            <p class="max-w-[10rem] truncate text-sm font-semibold text-slate-900">${esc(who)}</p>
            <p class="text-xs text-slate-500">${esc(ROLE_LABEL[u.role])}</p>
          </div>
          <button type="button" id="pw-btn" class="${C.btnSm}" title="Change password">${icon('key', 'h-4 w-4')}<span class="sr-only sm:not-sr-only">Password</span></button>
          <button type="button" id="logout-btn" class="${C.btnSm}">${icon('logout', 'h-4 w-4')}<span class="sr-only sm:not-sr-only">Sign out</span></button>
        </div>
      </div>
      <nav id="nav-mobile" aria-label="Main (mobile)" class="hidden border-t border-slate-200 px-4 py-2 md:hidden">
        <ul class="grid gap-1">${items.map(([path, r]) => `
          <li><a href="#/${path}" data-nav="${path}" class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 aria-[current=page]:bg-brand-50 aria-[current=page]:text-brand-800">${icon(r.icon, 'h-5 w-5')}${esc(r.nav)}</a></li>`).join('')}
        </ul>
      </nav>
    </header>
    <main id="main" tabindex="-1" class="mx-auto max-w-7xl px-4 py-6 focus:outline-none"></main>
    <footer class="no-print mx-auto max-w-7xl px-4 pb-8 pt-2 text-center text-xs text-slate-400">
      Lumina Library &middot; Makhanda &middot; All amounts in South African Rand (ZAR) &middot; SDP152
    </footer>`;

  const menuBtn = $('#menu-btn');
  const mobileNav = $('#nav-mobile');
  menuBtn.addEventListener('click', () => {
    const open = mobileNav.classList.toggle('hidden') === false;
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  });
  $('#pw-btn').addEventListener('click', passwordDialog);
  $('#logout-btn').addEventListener('click', async (e) => {
    await withBusy(e.currentTarget, 'Signing out', async () => { try { await api.post('/api/auth/logout'); } catch { /* ignore */ } });
    window.location.hash = '';
    showLogin({ type: 'info', message: 'You have been signed out.' });
  });
  route();
}

// ---------------------------------------------------------------- router
async function route() {
  if (!state.user) return;
  const mine = ++navSeq;
  let { path, params } = parseHash();
  let def = ROUTES[path];
  // Unknown route or not permitted for this role -> go home, with an explanation for forbidden pages.
  if (!def || !def.roles.includes(state.user.role)) {
    if (def) toast('warn', 'That page is only available to library staff.', { title: 'Access restricted' });
    window.history.replaceState(null, '', '#/dashboard');
    path = 'dashboard'; params = {}; def = ROUTES.dashboard;
  }

  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  $$('[data-nav]').forEach((a) => {
    if (a.dataset.nav === path) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('#nav-mobile')?.classList.add('hidden');
  $('#menu-btn')?.setAttribute('aria-expanded', 'false');

  const main = $('#main');
  main.innerHTML = '<div class="skeleton h-8 w-1/3"></div><div class="skeleton mt-4 h-40 w-full"></div>';
  main.setAttribute('aria-busy', 'true');
  try {
    const page = (await def.load()).default;
    if (mine !== navSeq) return;
    document.title = `${page.title} | Lumina Library`;
    main.innerHTML = '';
    const result = await page.render(main, { params });
    if (mine !== navSeq) { if (typeof result === 'function') result(); return; }
    cleanup = typeof result === 'function' ? result : null;
    main.setAttribute('aria-busy', 'false');
    // Move keyboard/screen-reader focus to the new page heading.
    const h = $('#page-title');
    if (h) h.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  } catch (err) {
    if (mine !== navSeq) return;
    console.error(err);
    main.setAttribute('aria-busy', 'false');
    main.innerHTML = `<div class="${C.card} p-8 text-center" role="alert"><p class="font-semibold text-slate-800">This page could not be loaded.</p>
      <p class="mt-1 text-sm text-slate-500">${esc(err.message)}</p><a href="#/dashboard" class="${C.btnSecondary} mt-4">Back to dashboard</a></div>`;
  }
}

// ---------------------------------------------------------------- boot
async function boot() {
  state.navigate = (path) => { window.location.hash = `#/${path}`; };

  setUnauthorizedHandler(() => {
    if (!state.user) return;     // already on the sign-in screen
    showLogin({ type: 'warn', message: 'Your session has ended. Please sign in again.' });
  });
  window.addEventListener('hashchange', route);

  try {
    const health = await api.get('/api/health');
    state.today = health.time.slice(0, 10);
    state.demo = !!health.demo;
    state.demoAccounts = health.demoAccounts || [];
  } catch (err) {
    appEl.setAttribute('aria-busy', 'false');
    appEl.innerHTML = `<main id="main" class="mx-auto max-w-md px-4 py-16 text-center" role="alert">
      <p class="text-lg font-semibold text-slate-800">Cannot reach the library server</p>
      <p class="mt-1 text-sm text-slate-500">${esc(err.message)}</p>
      <button type="button" class="${C.btn} mt-5" onclick="location.reload()">Reload</button></main>`;
    return;
  }

  try {
    const me = await api.get('/api/auth/me');
    state.user = me.user;
    startShell();
  } catch {
    showLogin();
  }

  // Keep the SAST "today" fresh for long-running sessions (due-date badges).
  setInterval(() => {
    api.get('/api/health').then((h) => { state.today = h.time.slice(0, 10); }).catch(() => {});
  }, 10 * 60 * 1000);
}

boot();
export { isStaff };
