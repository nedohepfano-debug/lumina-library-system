// Single shared client state (set up in app.js).
export const state = {
  user: null,            // { id, username, role, member }
  today: null,           // 'YYYY-MM-DD' in SAST, from the server clock
  demo: false,
  demoAccounts: [],
  navigate: (path) => { window.location.hash = `#/${path}`; },
};

export const isStaff = () => state.user && (state.user.role === 'admin' || state.user.role === 'librarian');
export const isAdmin = () => state.user && state.user.role === 'admin';
