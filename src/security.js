'use strict';
/**
 * FR1 - Secure Access primitives, built only on node:crypto.
 *   - scrypt password hashing with per-user random salt (OWASP-recommended KDF)
 *   - HS256 signed tokens (JWT-compatible) with expiry
 *   - constant-time comparisons
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, SCRYPT.keylen, SCRYPT, (err, dk) => {
      if (err) return reject(err);
      resolve(`scrypt$${SCRYPT.N}$${salt.toString('base64')}$${dk.toString('base64')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    const [scheme, n, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return resolve(false);
    const expected = Buffer.from(hashB64, 'base64');
    crypto.scrypt(password, Buffer.from(saltB64, 'base64'), expected.length,
      { N: Number(n), r: SCRYPT.r, p: SCRYPT.p }, (err, dk) => {
        if (err) return resolve(false);
        resolve(dk.length === expected.length && crypto.timingSafeEqual(dk, expected));
      });
  });
}

/** A valid hash of a random string, compared against when the username does not exist
 *  so that response time does not reveal which usernames are registered. */
const DUMMY_HASH = hashPasswordSync(crypto.randomBytes(8).toString('hex'));

/** Random temporary password that satisfies the password policy. */
function generateTempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (const b of crypto.randomBytes(8)) out += alphabet[b % alphabet.length];
  return `${out}#${crypto.randomInt(10, 99)}`;
}

// ---- Signing secret: env var, else persisted random secret in data/ ----
function loadSecret(dataDir) {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(dataDir, '.jwt_secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    fs.mkdirSync(dataDir, { recursive: true });
    const secret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function signToken(payload, secret, ttlSeconds) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** Returns the payload, or null if the token is malformed, tampered with or expired. */
function verifyToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (header.alg !== 'HS256') return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = { hashPassword, hashPasswordSync, verifyPassword, DUMMY_HASH,
  generateTempPassword, loadSecret, signToken, verifyToken };
