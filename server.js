'use strict';
/**
 * Lumina Library Resource & Member Management System  (SDP152)
 * Entry point: HTTP server, routing, error handling.
 *
 *   npm start            -> http://localhost:3000
 *   PORT=8080 npm start  -> custom port
 *
 * Environment
 *   PORT, HOST          listen address (default 3000 / 127.0.0.1)
 *   DB_PATH             SQLite file (default data/lumina.db)
 *   JWT_SECRET          token signing secret (default: random, persisted in data/.jwt_secret)
 *   NODE_ENV=production enables Secure cookies + HSTS
 *   DEMO_MODE=false     hides the demo-account hints on the sign-in page
 *   AUTO_SEED=false     do not seed demo data into an empty database
 */
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');

const { openDb } = require('./src/db');
const { seed, DEMO_PASSWORDS } = require('./src/seed');
const { loadSecret } = require('./src/security');
const { ApiError, fromDbError } = require('./src/errors');
const { Router, readJsonBody, RateLimiter, applySecurityHeaders, serveStatic, sendJson } = require('./src/http');

const PUBLIC_DIR = path.join(__dirname, 'public');

function createApp(options = {}) {
  const env = process.env;
  const isTest = env.NODE_ENV === 'test';
  const production = options.production ?? env.NODE_ENV === 'production';
  const quiet = options.quiet ?? isTest;
  const db = options.db || openDb();

  if (options.autoSeed ?? env.AUTO_SEED !== 'false') seed(db, quiet ? () => {} : console.log);

  const config = {
    production,
    secret: options.secret || loadSecret(path.join(__dirname, 'data')),
    demo: options.demo ?? env.DEMO_MODE !== 'false',
    limiter: new RateLimiter({ windowMs: 15 * 60 * 1000, max: 10, enabled: options.rateLimit ?? !isTest }),
  };

  // ---------------------------------------------------------------- routes
  const router = new Router();
  router.get('/api/health', () => ({
    status: 'ok',
    time: db.prepare("SELECT datetime('now','+2 hours') AS t").get().t,
    demo: config.demo,
    demoAccounts: config.demo ? [
      { role: 'Administrator', username: 'admin', password: DEMO_PASSWORDS.admin },
      { role: 'Librarian', username: 'librarian', password: DEMO_PASSWORDS.librarian },
      { role: 'Member (at 3-book limit)', username: 'LUM-0002', password: DEMO_PASSWORDS.member },
      { role: 'Member (overdue book)', username: 'LUM-0001', password: DEMO_PASSWORDS.member },
    ] : [],
  }));
  require('./src/routes/auth')(router);
  require('./src/routes/members')(router);
  require('./src/routes/books')(router);
  require('./src/routes/loans')(router);
  require('./src/routes/fines')(router);
  require('./src/routes/reports')(router);

  // ---------------------------------------------------------------- error middleware
  function sendError(ctx, err) {
    let apiErr = err instanceof ApiError ? err : fromDbError(err);
    if (!apiErr) {
      if (!quiet) console.error(`[${ctx.requestId}]`, err);
      apiErr = new ApiError(500, 'INTERNAL_ERROR',
        `Something went wrong on our side. Please try again. Reference: ${ctx.requestId.slice(0, 8)}`);
    }
    if (ctx.res.headersSent) { ctx.res.end(); return; }
    const headers = apiErr.retryAfter ? { 'Retry-After': String(apiErr.retryAfter) } : {};
    if (err.closeConnection) headers.Connection = 'close';
    if (ctx.url.pathname.startsWith('/api/')) {
      sendJson(ctx.res, apiErr.status, {
        error: { code: apiErr.code, message: apiErr.message, details: apiErr.details, requestId: ctx.requestId },
      }, headers);
    } else {
      ctx.res.writeHead(apiErr.status, { 'Content-Type': 'text/plain; charset=utf-8' });
      ctx.res.end(apiErr.message);
    }
  }

  // ---------------------------------------------------------------- dispatcher
  async function handleApi(ctx) {
    const { req, res, url } = ctx;
    const found = router.match(req.method, url.pathname);
    if (!found) throw new ApiError(404, 'NOT_FOUND', 'No such API endpoint.');
    if (found.allowed) {
      res.setHeader('Allow', [...new Set(found.allowed)].join(', '));
      throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'This method is not allowed on this endpoint.');
    }
    ctx.params = found.params;
    if (req.method !== 'GET' && req.method !== 'HEAD') ctx.body = await readJsonBody(req);

    const fns = found.fns;
    for (let i = 0; i < fns.length - 1; i += 1) await fns[i](ctx);   // guards
    const result = await fns[fns.length - 1](ctx);                     // handler

    if (ctx.setCookies.length) res.setHeader('Set-Cookie', ctx.setCookies);
    if (ctx.raw) {
      const body = ctx.raw.body;
      res.writeHead(ctx.raw.status, { ...ctx.raw.headers, 'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (result === undefined && ctx.status === 200) { res.writeHead(204); res.end(); return; }
    sendJson(res, ctx.status, result);
  }

  async function handle(req, res) {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    applySecurityHeaders(res, { production });

    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); res.end(); return; }
    const ctx = { req, res, db, url, query: Object.fromEntries(url.searchParams), params: {},
      body: undefined, user: null, status: 200, setCookies: [], raw: null, requestId, config };

    if (!quiet) {
      res.on('finish', () => console.log(
        `${new Date().toISOString().slice(11, 19)} ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`));
    }
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(ctx);
      else serveStatic(req, res, url.pathname, PUBLIC_DIR);
    } catch (err) {
      sendError(ctx, err);
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.on('clientError', (_err, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  return { server, db, config, close: () => new Promise((resolve) => { server.close(() => { db.close(); resolve(); }); }) };
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const app = createApp();
  app.server.listen(port, host, () => {
    console.log(`\n  Lumina Library is running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    if (app.config.demo) {
      console.log('  Demo sign-ins:  admin / Admin@123   librarian / Librarian@123   LUM-0002 / Member@123');
    }
    console.log('  Press Ctrl+C to stop.\n');
  });
  const shutdown = () => { console.log('\nShutting down...'); app.close().then(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
}
