'use strict';
/**
 * Minimal HTTP toolkit (router, body parsing, static files, cookies, rate limiting,
 * security headers) built on node:http only.
 */
const fs = require('node:fs');
const path = require('node:path');
const { ApiError } = require('./errors');

// ------------------------------------------------------------ Router
class Router {
  constructor() { this.routes = []; }

  add(method, pattern, ...fns) {
    const keys = [];
    const source = pattern
      .replace(/\./g, '\\.')
      .replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
    this.routes.push({ method, re: new RegExp(`^${source}/?$`), keys, fns });
    return this;
  }
  get(p, ...f) { return this.add('GET', p, ...f); }
  post(p, ...f) { return this.add('POST', p, ...f); }
  put(p, ...f) { return this.add('PUT', p, ...f); }
  delete(p, ...f) { return this.add('DELETE', p, ...f); }

  /** -> { fns, params } | { allowed: [...] } (path known, wrong method) | null */
  match(method, pathname) {
    const allowed = [];
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method) { allowed.push(r.method); continue; }
      const params = {};
      r.keys.forEach((k, i) => {
        try { params[k] = decodeURIComponent(m[i + 1]); } catch { params[k] = ''; }
      });
      return { fns: r.fns, params };
    }
    return allowed.length ? { allowed } : null;
  }
}

// ------------------------------------------------------------ Body parsing
const MAX_BODY_BYTES = 20 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
    if (!hasBody) return resolve(undefined);
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      req.resume();
      return reject(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send requests as application/json.'));
    }
    const tooLarge = () => {
      // Answer 413 properly (instead of destroying the socket): stop buffering, discard the rest
      // of the upload, and ask the client to close the connection once the response is sent.
      req.removeAllListeners('data');
      req.resume();
      const err = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
      err.closeConnection = true;
      reject(err);
    };
    if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) return tooLarge();
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { rejected = true; tooLarge(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (rejected) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ApiError(400, 'INVALID_JSON', 'The request body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

// ------------------------------------------------------------ Cookies
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function serializeCookie(name, value, { maxAge, secure } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  if (secure) c += '; Secure';
  return c;
}

// ------------------------------------------------------------ Rate limiting
class RateLimiter {
  constructor({ windowMs, max, enabled = true }) {
    this.windowMs = windowMs; this.max = max; this.enabled = enabled; this.hits = new Map();
  }
  _prune(key, now) {
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list); else this.hits.delete(key);
    return list;
  }
  /** Throws 429 if the key is over its budget. */
  check(key) {
    if (!this.enabled) return;
    const list = this._prune(key, Date.now());
    if (list.length >= this.max) {
      const retry = Math.ceil((this.windowMs - (Date.now() - list[0])) / 1000);
      const err = new ApiError(429, 'TOO_MANY_ATTEMPTS',
        `Too many failed sign-in attempts. Try again in ${Math.ceil(retry / 60)} minute(s).`);
      err.retryAfter = retry;
      throw err;
    }
  }
  fail(key) {
    if (!this.enabled) return;
    const list = this._prune(key, Date.now());
    list.push(Date.now());
    this.hits.set(key, list);
  }
  reset(key) { this.hits.delete(key); }
}

// ------------------------------------------------------------ Security headers
function applySecurityHeaders(res, { production }) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (production) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
}

// ------------------------------------------------------------ Static files
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname, root) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
  }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); res.end(); return; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(root, path.normalize(rel));
  const inside = file.startsWith(root + path.sep);
  const hidden = rel.split('/').some((seg) => seg.startsWith('.'));
  if (!inside || hidden) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

function sendJson(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

module.exports = { Router, readJsonBody, parseCookies, serializeCookie, RateLimiter,
  applySecurityHeaders, serveStatic, sendJson, MAX_BODY_BYTES };
