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
import * as perf from "../utils/perf"

const HERMES = process.env.HERMES_HOME || `${process.env.HOME || homedir()}/.hermes`
// Source provenance mirrors hermes-home.ts makeSource("state.db") —
// inlined to keep this module leaf (hermes-home re-exports from here).
export type Source = { file: string; relative: string; label: string }
const SRC: Source = { file: `${HERMES}/state.db`, relative: "state.db", label: "state.db" }
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

/** Shared read handle. Null when state.db doesn't exist yet.
 *  RW-no-create, not readonly — Bun 1.3.x readonly mode can fail on
 *  WAL DBs before sidecars exist (gh#29). We only SELECT on it. */
export const stateDb = (): Database | null => {
  if (conn.ro) return conn.ro
  try { return (conn.ro = new Database(conn.path, { readwrite: true, create: false })) }
  catch { return null }
}

/** Test hook — drop the cached handle so the next call reopens.
 *  Finalize statements BEFORE close: bun:sqlite Statement finalizers at
 *  process exit otherwise hit a freed sqlite3* and segfault. */
export const resetDb = () => {
  for (const s of stmts.values()) s.finalize()
  stmts.clear()
  msgCols.clear()
  conn.ro?.close()
  conn.ro = null
}

// Prepared-statement cache keyed by SQL text. db.query() already
// memoises internally, but holding our own map lets stats()/perf
// count distinct statements and makes the no-db path trivially cheap.
const stmts = new Map<string, Statement>()
const msgCols = new Map<string, boolean>()
const q = (sql: string): Statement | null => {
  const db = stateDb()
  if (!db) return null
  let s = stmts.get(sql)
  if (!s) stmts.set(sql, (s = db.query(sql)))
  return s
}

const hasMsgCol = (name: string): boolean => {
  const hit = msgCols.get(name)
  if (hit !== undefined) return hit
  const db = stateDb()
  const ok = db
    ? db.query("PRAGMA table_info(messages)").all()
        .some(r => (r as { name?: string }).name === name)
    : false
  msgCols.set(name, ok)
  return ok
}

/** A row from the sessions table enriched for the list/detail view. */
export interface SessionRow {
  source: Source
  id: string
  sessionSource: string
  model: string | null
  billing_provider: string | null
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
  /** External messaging platform's original message id. Present only
   *  on Hermes Agent state.db schema v13+. */
  platform_message_id?: string | null
  /** 1 for group-context messages observed but not dispatched to the
   *  agent. Present only on Hermes Agent state.db schema v13+. */
  observed?: number | null
  at: number
}
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

// Column projection shared by roots()/children()/one(). Aliased `s`.
// First-user-msg, last-user-msg, last-active, and subagent_count are
// correlated subqueries — cheap at herm's DB sizes (thousands of rows)
// and keeps the outer query a plain single-table scan.
const COLS = `
  s.id, s.source, s.model, s.billing_provider, s.started_at, s.ended_at, s.end_reason,
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
  id: string; source: string; model: string | null; billing_provider: string | null
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
  billing_provider: r.billing_provider,
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

/** Newest real TUI/CLI conversation. Target of `-c` and source of the
 *  splash continue-prompt title.
 *
 *  Newest row with messages (root or continuation — subagents/branches
 *  excluded), then walk the compression chain to its live tip. The tip
 *  can have 0 messages when compaction rotated but no turn landed yet. */
export const lastReal = (): SessionRow | undefined => {
  const hit = q(`
    SELECT s.id FROM sessions s
    LEFT JOIN sessions p ON p.id = s.parent_session_id
    WHERE s.source IN ('tui', 'cli') AND s.message_count > 0
      AND (s.parent_session_id IS NULL OR ${CONT("s")})
    ORDER BY s.started_at DESC LIMIT 1
  `)?.get() as { id: string } | undefined
  if (!hit) return undefined
  return byId(chainTip(hit.id)) ?? undefined
}

/** Resolve any id in a compression chain to the live tip. Walks up to
 *  the chain root via CONT links, then forward via `tip()`. Does NOT
 *  filter by message_count — callers check that. */
export const chainTip = (sid: string): string => tip(walkUp(sid))

/** Walk up continuation links to the chain root. Stops at any non-CONT
 *  link (subagent/branch parents are NOT crossed — see :146). */
function walkUp(sid: string): string {
  const step = q(
    `SELECT p.id FROM sessions c
     JOIN sessions p ON p.id = c.parent_session_id
     WHERE c.id = ? AND ${CONT("c")}`,
  )
  let cur = sid
  for (let i = 0; i < 100; i++) {
    const prev = step?.get(cur) as { id: string } | undefined
    if (!prev) return cur
    cur = prev.id
  }
  return cur
}

/** Root-level sessions, newest-started first, compression chains
 *  projected to their tip (the resumable end), with lineage_root_id
 *  recording the original root when projection happened. Mirrors
 *  list_sessions_rich.
 *
 *  Each projected row carries BOTH the root's started_at and the tip's
 *  last_active, so the Sessions tab can order by either without the
 *  reader committing to one. See prefs.sessions.sort. */
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
      // Tip stats (incl. last_active) replace the root's, but
      // started_at stays the root's so Detail's Started/Duration
      // span the whole chain and "started" sort order is preserved.
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

/** First two and last two raw message rows for a session, chronological.
 *  Content is SUBSTR(…,400)'d in SQL — the peek view renders one line
 *  per row, so anything past the first ~200 chars is wasted. */
export function peek(sid: string, _n = 4): PeekMsg[] {
  const end = perf.mark("io:sessions.peek")
  try {
    const ext = [
      hasMsgCol("platform_message_id")
        ? "platform_message_id"
        : "NULL AS platform_message_id",
      hasMsgCol("observed") ? "observed" : "NULL AS observed",
    ]
    return ((q(
      `SELECT role, SUBSTR(content,1,400) AS content, tool_name,
              SUBSTR(tool_calls,1,400) AS tool_calls, timestamp AS at,
              ${ext.join(", ")}
       FROM (
         SELECT * FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 2)
         UNION
         SELECT * FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 2)
       )
       ORDER BY id ASC`,
    )?.all(sid, sid) ?? []) as PeekMsg[]).map((r) => ({
      role: r.role,
      content: r.content,
      tool_name: r.tool_name,
      tool_calls: r.tool_calls,
      ...(r.platform_message_id !== null && { platform_message_id: r.platform_message_id }),
      ...(r.observed !== null && { observed: r.observed }),
      at: r.at,
    }))
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
// hermes_cli/goals.py persists GoalState as JSON in state_meta keyed
// 'goal:<sid>'. status: active | paused | done | cleared. Only the
// fields herm consumes are surfaced.

export type ChecklistItem = {
  text: string
  status: "pending" | "completed" | "impossible"
  addedBy?: "judge" | "user"
}

export type GoalState = {
  goal: string
  status: "active" | "paused" | "done" | "cleared"
  turn_count?: number
  max_turns?: number | null
  checklist?: ChecklistItem[]
  subgoals?: string[]
  decomposed?: boolean
}

const VALID_ITEM: ReadonlySet<ChecklistItem["status"]> =
  new Set<ChecklistItem["status"]>(["pending", "completed", "impossible"])

const parseItem = (raw: unknown): ChecklistItem | null => {
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  const text = typeof o.text === "string" ? o.text : ""
  if (!text.trim()) return null
  const s = typeof o.status === "string" ? o.status : "pending"
  const status = (VALID_ITEM.has(s as ChecklistItem["status"])
    ? s : "pending") as ChecklistItem["status"]
  const by = typeof o.added_by === "string" ? o.added_by : undefined
  const addedBy = by === "judge" || by === "user" ? by : undefined
  return { text, status, addedBy }
}

export function goalState(sid: string): GoalState | null {
  const row = q("SELECT value FROM state_meta WHERE key = ?")
    ?.get(`goal:${sid}`) as { value: string } | undefined
  if (!row) return null
  try {
    const j = JSON.parse(row.value) as Record<string, unknown>
    const rawList = Array.isArray(j.checklist) ? j.checklist : []
    const checklist = rawList.map(parseItem).filter((x): x is ChecklistItem => x !== null)
    const subgoals = (Array.isArray(j.subgoals) ? j.subgoals : [])
      .map(s => typeof s === "string" ? s.trim() : "")
      .filter((s): s is string => s.length > 0)
    return {
      goal: String(j.goal ?? ""),
      status: (j.status as GoalState["status"]) ?? "active",
      turn_count: typeof j.turn_count === "number" ? j.turn_count : undefined,
      max_turns: (j.max_turns as number | null | undefined) ?? null,
      checklist: checklist.length > 0 ? checklist : undefined,
      subgoals: subgoals.length > 0 ? subgoals : undefined,
      decomposed: j.decomposed === true ? true : undefined,
    }
  } catch { return null }
}
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

export * as sdb from "./sessions-db"
