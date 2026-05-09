/**
 * sessions-db.ts — herm's window onto the Hermes session store.
 *
 * Architectural line: the Sessions tab is a **local state.db reader**.
 * Stock tui_gateway covers ≈30% of what the tab needs — session.list
 * returns {id, title, preview, started_at, message_count, source} and
 * nothing else. There is no session.search, no lineage/children RPC,
 * no arbitrary-id session.history, and session.title only retitles the
 * *current* gateway session. Per herm policy we don't patch upstream,
 * so everything richer than "which ids can the gateway resume" reads
 * state.db directly. The gateway RPCs herm *does* use:
 *
 *   session.list   — source of truth for "resumable" (row.id is known
 *                    to the connected gateway process)
 *   session.delete — preferred over direct DELETE because it refuses
 *                    to remove the active session and cleans transcript
 *                    files; local remove() is the fallback
 *
 * All query functions here share ONE readonly connection and ONE
 * parent→child classification rule. Upstream owns that semantic
 * (hermes_state.py:893-970); if it changes, `kind()` is the only line
 * that moves.
 */

import { Database, type Statement } from "bun:sqlite"
import { homedir } from "os"
import * as perf from "./perf"

const HERMES = process.env.HERMES_HOME || `${process.env.HOME || homedir()}/.hermes`
// Source provenance mirrors hermes-home.ts makeSource("state.db") —
// inlined to keep this module leaf (hermes-home re-exports from here).
export type Source = { file: string; relative: string; label: string }
const SRC: Source = { file: `${HERMES}/state.db`, relative: "state.db", label: "state.db" }

// ─── Connection ──────────────────────────────────────────────────────
// One readonly handle, opened on first use. SQLite readonly connections
// see writes from other processes (WAL or rollback), so the gateway
// appending messages while herm holds this open is fine. Writes
// (rename/remove) open a short-lived RW handle — rare enough that
// pooling isn't worth it.
//
// `conn.path` is mutable so the io worker can rebind it — Bun workers
// inherit the OS environ (and under `bun test` ignore process.env
// writes entirely), so the parent passes its resolved HERMES_HOME
// explicitly instead of relying on env propagation.

const conn = { path: SRC.file, ro: null as Database | null }

/** Point all readers at a specific HERMES_HOME. Drops the cached
 *  connection and statement cache. Used by the io worker. */
export const setHome = (h: string) => {
  const next = `${h}/state.db`
  if (conn.path === next) return
  conn.path = SRC.file = next
  resetDb()
}

/** Shared readonly handle. Null when state.db doesn't exist yet. */
export const stateDb = (): Database | null => {
  if (conn.ro) return conn.ro
  try { return (conn.ro = new Database(conn.path, { readonly: true })) }
  catch { return null }
}

/** Test hook — drop the cached handle so the next call reopens.
 *  Finalize statements BEFORE close: bun:sqlite Statement finalizers at
 *  process exit otherwise hit a freed sqlite3* and segfault. */
export const resetDb = () => {
  for (const s of stmts.values()) s.finalize()
  stmts.clear()
  conn.ro?.close()
  conn.ro = null
}

// Prepared-statement cache keyed by SQL text. db.query() already
// memoises internally, but holding our own map lets stats()/perf
// count distinct statements and makes the no-db path trivially cheap.
const stmts = new Map<string, Statement>()
const q = (sql: string): Statement | null => {
  const db = stateDb()
  if (!db) return null
  let s = stmts.get(sql)
  if (!s) stmts.set(sql, (s = db.query(sql)))
  return s
}

// ─── Types ───────────────────────────────────────────────────────────

/** A row from the sessions table enriched for the list/detail view. */
export interface SessionRow {
  source: Source
  id: string
  sessionSource: string
  model: string | null
  started_at: number
  ended_at: number | null
  end_reason: string | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  estimated_cost_usd: number | null
  title: string | null
  lastMessage: string | null
  last_active: number | null
  parent_session_id: string | null
  /** Count of subagent children — see kind() === 'subagent'. */
  subagent_count: number
  /** Original root id when this row was tip-projected from a
   *  compression chain; null otherwise. */
  lineage_root_id: string | null
}

export interface LineageInfo {
  continuesFrom?: { id: string; title: string | null }
  compressedTo?: { id: string; title: string | null }
}

export interface SessionHit {
  session_id: string
  snippet: string
  role: string
  source: string
  model: string | null
  started_at: number
  title: string | null
}

/** One raw message row for transcript peek. content is SUBSTR-capped
 *  in SQL so multi-MB tool outputs don't allocate on read. */
export interface PeekMsg {
  role: "user" | "assistant" | "tool" | "system"
  content: string | null
  tool_name: string | null
  /** JSON string of tool_calls when role='assistant' and the model
   *  invoked tools instead of / as well as emitting content. */
  tool_calls: string | null
  at: number
}

// ─── parent→child classification ─────────────────────────────────────
//
// parent_session_id is overloaded across three unrelated relationships
// in hermes-agent. The ONLY discriminator is (parent.end_reason,
// child.started_at vs parent.ended_at):
//
//   subagent     — child started while parent was still live
//                  (parent.ended_at NULL OR child.started_at < it)
//   continuation — parent.end_reason='compression' AND child started
//                  at/after parent.ended_at
//   branch       — parent.end_reason='branched'    AND child started
//                  at/after parent.ended_at
//
// This mirrors hermes_state.py compression-tip walker (:893-926) and
// list_sessions_rich root filter (:956-971). Every query below derives
// its WHERE from these three predicates — change the rule here, not
// per-call. They take the child-table alias because queries variously
// see the child as the outer `s` or an inner `c`.

export type Kind = "root" | "subagent" | "continuation" | "branch"

const SUB  = (c: string) => `(p.ended_at IS NULL OR ${c}.started_at < p.ended_at)`
const CONT = (c: string) => `(p.end_reason = 'compression' AND ${c}.started_at >= p.ended_at)`
const BR   = (c: string) => `(p.end_reason = 'branched'    AND ${c}.started_at >= p.ended_at)`

/** Classify a child session given its parent. Pure — for tests and
 *  any caller that already has both rows in hand. */
export const kind = (
  parent: { ended_at: number | null; end_reason: string | null } | null,
  child: { started_at: number },
): Kind => {
  if (!parent) return "root"
  if (parent.ended_at == null || child.started_at < parent.ended_at) return "subagent"
  if (parent.end_reason === "compression") return "continuation"
  if (parent.end_reason === "branched") return "branch"
  return "subagent"
}

// ─── Shared SQL ──────────────────────────────────────────────────────

// Column projection shared by roots()/children()/one(). Aliased `s`.
// First-user-msg, last-user-msg, last-active, and subagent_count are
// correlated subqueries — cheap at herm's DB sizes (thousands of rows)
// and keeps the outer query a plain single-table scan.
const COLS = `
  s.id, s.source, s.model, s.started_at, s.ended_at, s.end_reason,
  s.message_count, s.tool_call_count,
  s.input_tokens, s.output_tokens,
  s.cache_read_tokens, s.cache_write_tokens, s.reasoning_tokens,
  s.estimated_cost_usd, s.parent_session_id,
  COALESCE(s.title,
    (SELECT SUBSTR(content,1,120) FROM messages
     WHERE session_id = s.id AND role = 'user' ORDER BY id LIMIT 1)) AS title,
  (SELECT SUBSTR(content,1,120) FROM messages
   WHERE session_id = s.id AND role = 'user' ORDER BY id DESC LIMIT 1) AS lastMessage,
  (SELECT MAX(timestamp) FROM messages WHERE session_id = s.id) AS last_active,
  (SELECT COUNT(*) FROM sessions c
   WHERE c.parent_session_id = s.id
     AND (s.ended_at IS NULL OR c.started_at < s.ended_at)) AS subagent_count`

type Raw = {
  id: string; source: string; model: string | null
  started_at: number; ended_at: number | null; end_reason: string | null
  message_count: number; tool_call_count: number
  input_tokens: number; output_tokens: number
  cache_read_tokens: number; cache_write_tokens: number; reasoning_tokens: number
  estimated_cost_usd: number | null; parent_session_id: string | null
  title: string | null; lastMessage: string | null
  last_active: number | null; subagent_count: number
}

const toRow = (r: Raw, lineage: string | null = null): SessionRow => ({
  source: SRC,
  id: r.id,
  sessionSource: r.source,
  model: r.model,
  started_at: r.started_at,
  ended_at: r.ended_at,
  end_reason: r.end_reason,
  message_count: r.message_count,
  tool_call_count: r.tool_call_count,
  input_tokens: r.input_tokens,
  output_tokens: r.output_tokens,
  cache_read_tokens: r.cache_read_tokens,
  cache_write_tokens: r.cache_write_tokens,
  reasoning_tokens: r.reasoning_tokens,
  estimated_cost_usd: r.estimated_cost_usd,
  title: r.title,
  lastMessage: r.lastMessage,
  last_active: r.last_active,
  parent_session_id: r.parent_session_id,
  subagent_count: r.subagent_count,
  lineage_root_id: lineage,
})

/** Fetch one session by id with the full column projection. */
const one = (id: string): Raw | null =>
  (q(`SELECT ${COLS} FROM sessions s WHERE s.id = ?`)?.get(id) as Raw | undefined) ?? null

/** Single session by id, or null if missing / db unavailable. */
export const byId = (id: string): SessionRow | null => {
  const r = one(id)
  return r ? toRow(r) : null
}

/** Newest root TUI session that actually has messages. Target of `-c`
 *  and source of the splash continue-prompt title.
 *
 * Strategy: find the newest TUI session with messages (could be a root OR
 * a continuation), then walk backward to the root and forward to the tip.
 * This handles compression chains where messages live in the continuation,
 * not the root. */
export const lastReal = (): SessionRow | undefined => {
  // Find the newest session with messages — includes both TUI and CLI sessions.
  // herm -c should resume the last session regardless of interface used.
  const newestStmt = q(`
    SELECT s.id FROM sessions s
    WHERE s.source IN ('tui', 'cli') AND s.message_count > 0
    ORDER BY s.started_at DESC
    LIMIT 1
  `)
  const newest = newestStmt?.get() as { id: string } | undefined
  if (!newest) return undefined

  // Walk backward: if newest is a continuation, walk up to the root.
  const rootId = walkUp(newest.id)
  // Walk forward: the root may itself be the tip of a compression chain.
  const tipId = resolveChainTip(rootId)
  const row = byId(tipId)
  // Guard: require messages (tip might be a 0-msg stub).
  return row?.message_count && row.message_count > 0 ? row : undefined
}

/** Resolve a session id to its chain tip (following compression continuations).
 *  Unlike lastReal(), this does NOT filter by message_count — it returns the
 *  actual live end of the chain regardless of whether it has messages.
 *  Used by useSession boot() to resolve the stored lastSessionId before
 *  checking whether its tip is a reusable 0-msg stub. */
export const resolveChainTip = (sid: string): string =>
  tip(walkUp(sid))

/** Walk up a compression chain to the root (parent_session_id IS NULL).
 * Returns the id passed in if it is already a root. */
function walkUp(sid: string): string {
  let cur = sid
  for (let i = 0; i < 100; i++) {
    const parentStmt = q(`SELECT parent_session_id FROM sessions WHERE id = ?`)
    const parent = parentStmt?.get(cur) as { parent_session_id: string | null } | undefined
    if (!parent || parent.parent_session_id === null) return cur
    cur = parent.parent_session_id
  }
  return cur // cap hit — return what we have
}

// ─── Readers ─────────────────────────────────────────────────────────

/** Root-level sessions, newest first, compression chains projected to
 *  their tip (the resumable end), with lineage_root_id recording the
 *  original root when projection happened. Mirrors list_sessions_rich. */
export function roots(limit = 30): SessionRow[] {
  const end = perf.mark("io:sessions.roots")
  try {
    // Root filter: no parent, OR parent link is a branch. Subagents
    // and continuations are hidden — they surface via children()/
    // lineage() instead. `p`/`c` aliases satisfy SUB/CONT/BR above.
    const raw = (q(
      `SELECT ${COLS} FROM sessions s
       WHERE s.parent_session_id IS NULL
          OR EXISTS (SELECT 1 FROM sessions p
                     WHERE p.id = s.parent_session_id
                       AND ${BR("s")})
       ORDER BY s.started_at DESC
       LIMIT ?`,
    )?.all(limit) ?? []) as Raw[]

    return raw.map((r) => {
      if (r.end_reason !== "compression") return toRow(r)
      const tid = tip(r.id)
      if (tid === r.id) return toRow(r)
      const t = one(tid)
      // Tip stats replace the root's, but started_at stays the root's
      // so chronological list order is preserved.
      return t ? { ...toRow(t, r.id), started_at: r.started_at } : toRow(r)
    })
  } finally { end() }
}

/** Subagent children of a session, spawn-order. Each child carries its
 *  own subagent_count so the tree view can recurse to N levels. */
export function children(pid: string): SessionRow[] {
  const end = perf.mark("io:sessions.children")
  try {
    return ((q(
      `SELECT ${COLS} FROM sessions s
       JOIN sessions p ON p.id = s.parent_session_id
       WHERE s.parent_session_id = ? AND ${SUB("s")}
       ORDER BY s.started_at ASC`,
    )?.all(pid) ?? []) as Raw[]).map(r => toRow(r))
  } finally { end() }
}

/** Compression-chain neighbours of a session. */
export function lineage(sid: string): LineageInfo {
  const end = perf.mark("io:sessions.lineage")
  try {
    const pred = q(
      `SELECT p.id, p.title FROM sessions c
       JOIN sessions p ON p.id = c.parent_session_id
       WHERE c.id = ? AND ${CONT("c")}`,
    )?.get(sid) as { id: string; title: string | null } | undefined
    const succ = q(
      `SELECT c.id, c.title FROM sessions c
       JOIN sessions p ON p.id = c.parent_session_id
       WHERE p.id = ? AND ${CONT("c")}
       ORDER BY c.started_at DESC LIMIT 1`,
    )?.get(sid) as { id: string; title: string | null } | undefined
    return {
      ...(pred && { continuesFrom: pred }),
      ...(succ && { compressedTo: succ }),
    }
  } finally { end() }
}

/** Walk the compression chain forward to its live tip. Bounded at 100
 *  links (upstream's defensive cap). */
function tip(sid: string): string {
  const step = q(
    `SELECT c.id FROM sessions c
     JOIN sessions p ON p.id = c.parent_session_id
     WHERE p.id = ? AND ${CONT("c")}
     ORDER BY c.started_at DESC LIMIT 1`,
  )
  let cur = sid
  for (let i = 0; i < 100; i++) {
    const next = step?.get(cur) as { id: string } | undefined
    if (!next) return cur
    cur = next.id
  }
  return cur
}

/** Last `n` raw message rows for a session, chronological. Content
 *  is SUBSTR(…,400)'d in SQL — the peek view renders one line per
 *  row, so anything past the first ~200 chars is wasted. Uses the
 *  (session_id, timestamp) index; sub-ms for any realistic n. */
export function peek(sid: string, n = 60): PeekMsg[] {
  const end = perf.mark("io:sessions.peek")
  try {
    return ((q(
      `SELECT role, SUBSTR(content,1,400) AS content, tool_name,
              SUBSTR(tool_calls,1,400) AS tool_calls, timestamp AS at
       FROM (SELECT * FROM messages WHERE session_id = ?
             ORDER BY id DESC LIMIT ?)
       ORDER BY id ASC`,
    )?.all(sid, n) ?? []) as PeekMsg[])
  } finally { end() }
}

/** Most-recent session with a "real" system prompt (long enough to
 *  carry SOUL/memory/skills, not the ~700-char generic fallback).
 *  Worker-side half of home's `systemPrompt` slice — token counting
 *  happens on the main thread so the worker never loads gpt-tokenizer. */
export const systemPrompt = (): { id: string; text: string } | null =>
  (q(`SELECT id, system_prompt AS text FROM sessions
      WHERE system_prompt IS NOT NULL AND length(system_prompt) > 1000
      ORDER BY started_at DESC LIMIT 1`,
  )?.get() as { id: string; text: string } | undefined) ?? null

// ─── Goal state ──────────────────────────────────────────────────────
// hermes_cli/goals.py persists GoalState as JSON in state_meta keyed
// 'goal:<sid>'. status: active | paused | done | cleared. Only the
// fields herm consumes are surfaced.

export type GoalState = {
  goal: string
  status: "active" | "paused" | "done" | "cleared"
  turn_count?: number
  max_turns?: number | null
}

export function goalState(sid: string): GoalState | null {
  const row = q("SELECT value FROM state_meta WHERE key = ?")
    ?.get(`goal:${sid}`) as { value: string } | undefined
  if (!row) return null
  try {
    const j = JSON.parse(row.value) as Record<string, unknown>
    return {
      goal: String(j.goal ?? ""),
      status: (j.status as GoalState["status"]) ?? "active",
      turn_count: typeof j.turn_count === "number" ? j.turn_count : undefined,
      max_turns: (j.max_turns as number | null | undefined) ?? null,
    }
  } catch { return null }
}

// ─── Search ──────────────────────────────────────────────────────────
// FTS5 over messages_fts — same table/triggers SessionDB builds, so
// results match `hermes sessions search` and the session_search tool.

// FTS5 treats - . ( ) " as syntax. Quote non-alnum tokens as phrases;
// bare words get a * suffix so incremental typing narrows live.
const fts = (s: string): string =>
  s.trim().split(/\s+/).filter(Boolean)
    .map(w => /^\w+$/.test(w) ? `${w}*` : `"${w.replace(/"/g, '""')}"`)
    .join(" ")

export function search(query: string, limit = 30): SessionHit[] {
  const m = fts(query)
  if (!m) return []
  const end = perf.mark("io:sessions.search")
  try {
    const raw = (q(
      `SELECT m.session_id, m.role,
              snippet(messages_fts, 0, '>>>', '<<<', '...', 40) AS snippet,
              s.source, s.model, s.started_at,
              COALESCE(s.title, SUBSTR(m.content, 1, 120)) AS title
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       JOIN sessions s ON s.id = m.session_id
       WHERE messages_fts MATCH ?
       ORDER BY rank LIMIT ?`,
    )?.all(m, limit * 4) ?? []) as Array<SessionHit & { session_id: string }>
    const seen = new Set<string>()
    return raw.filter(r =>
      !seen.has(r.session_id) && (seen.add(r.session_id), true),
    ).slice(0, limit)
  } finally { end() }
}

// ─── Writes ──────────────────────────────────────────────────────────
// Fresh RW handle per call — writes are rare (user-initiated) and a
// long-lived writer would hold locks the gateway's own connection
// wants. Callers should prefer the session.delete RPC and fall back
// here only when the gateway is down.

export function rename(sid: string, title: string): boolean {
  const db = new Database(conn.path)
  try {
    db.run("UPDATE sessions SET title = ? WHERE id = ?", [title, sid])
    return (db.query("SELECT changes() AS c").get() as { c: number }).c > 0
  } finally { db.close() }
}

/** Delete a session. Orphans children (matches upstream delete_session). */
export function remove(sid: string): boolean {
  const db = new Database(conn.path)
  try {
    if (!db.query("SELECT 1 FROM sessions WHERE id = ?").get(sid)) return false
    db.run("UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id = ?", [sid])
    db.run("DELETE FROM messages WHERE session_id = ?", [sid])
    db.run("DELETE FROM sessions WHERE id = ?", [sid])
    return true
  } finally { db.close() }
}
