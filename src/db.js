'use strict';
/**
 * Database access layer.
 * Uses Node's built-in SQLite driver (node:sqlite) - no native build step.
 * The schema (src/schema.sql) is applied idempotently on every start.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB = path.join(__dirname, '..', 'data', 'lumina.db');

function openDb(file = process.env.DB_PATH || DEFAULT_DB) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}

/** Run fn inside a single atomic transaction (rolls back on any throw). */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Read a policy value from the settings table. */
function setting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key).value;
}

/** SAST (UTC+2) calendar date, matching the SQL used inside the schema. */
function today(db) {
  return db.prepare("SELECT date('now', '+2 hours') AS d").get().d;
}

module.exports = { openDb, tx, setting, today, DEFAULT_DB };
