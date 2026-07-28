// Shared fixture for the sandbox HERMES_HOME/state.db.
//
// Multiple test files read this db (analytics, memory-activity,
// recentSessions); the preload sandbox is process-wide, so whichever
// file's beforeAll fires first owns the CREATE TABLE. Centralise the
// superset schema here and have every writer use named-column inserts
// so file order never matters.

import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"

const home = () => {
  const path = process.env.HERMES_HOME
  if (path && path !== `${homedir()}/.hermes`) return path
  throw new Error(
    "state-db fixture: HERMES_HOME is unset or points at the real ~/.hermes. " +
    "Run under `bun test` (preload sandboxes it) or set HERMES_HOME explicitly.",
  )
}

export const openStateDb = (): Database => {
  const root = home()
  mkdirSync(root, { recursive: true })
  const db = new Database(`${root}/state.db`, { create: true })
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, title TEXT, source TEXT, model TEXT, billing_provider TEXT,
    started_at REAL, ended_at REAL, end_reason TEXT,
    message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    estimated_cost_usd REAL, actual_cost_usd REAL,
    parent_session_id TEXT,
    model_config TEXT
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT, role TEXT, content TEXT,
    tool_calls TEXT, tool_name TEXT, timestamp REAL
  )`)
  // FTS5 mirror of messages.content + tool_name + tool_calls — mirrors
  // the index + triggers hermes-agent's SessionDB builds. Needed so
  // searchSessions() tests exercise the real FTS code path. Uses a
  // default (non-contentless) index so DELETE works, matching
  // hermes_state.py's own declaration.
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(content, tokenize='porter')`)
  db.run(`CREATE TRIGGER IF NOT EXISTS messages_fts_insert
    AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (
        new.id,
        COALESCE(new.content, '') || ' ' || COALESCE(new.tool_name, '') || ' ' || COALESCE(new.tool_calls, '')
      );
    END`)
  db.run(`CREATE TRIGGER IF NOT EXISTS messages_fts_delete
    AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.id;
    END`)
  db.run(`CREATE TABLE IF NOT EXISTS state_meta (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  )`)
  return db
}
