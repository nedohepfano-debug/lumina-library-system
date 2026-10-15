// Thin fetch wrapper: JSON in/out, anti-CSRF header, uniform error objects.

export class ApiClientError extends Error {
  constructor(status, code, message, details, requestId) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details || [];
    this.requestId = requestId;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

function toQuery(params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

async function request(method, path, { body, query, signal, blob } = {}) {
  let res;
  try {
    res = await fetch(`${path}${toQuery(query)}`, {
      method,
      credentials: 'same-origin',
      signal,
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'lumina-web',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiClientError(0, 'NETWORK_ERROR',
      'Cannot reach the library server. Check that it is running and try again.');
  }

  if (res.ok) {
    if (blob) return res.blob();
    return res.status === 204 ? null : res.json();
  }

  let payload = {};
  try { payload = await res.json(); } catch { /* non-JSON error body */ }
  const e = payload.error || {};
  const err = new ApiClientError(res.status, e.code || 'ERROR', e.message || `Request failed (${res.status}).`,
    e.details, e.requestId);
  if (res.status === 401 && path !== '/api/auth/login') onUnauthorized(err);
  throw err;
}

export const api = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, body, opts) => request('POST', path, { ...opts, body: body ?? {} }),
  put: (path, body, opts) => request('PUT', path, { ...opts, body }),
  del: (path, opts) => request('DELETE', path, opts),
};
