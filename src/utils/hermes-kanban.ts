// Window onto the kanban board(s) under ~/.hermes/.
//
// Kanban is deliberately profile-agnostic (the board IS the
// coordination primitive between profiles), so this reads the
// HERMES_HOME-relative paths and shows every tenant's tasks.
//
// Upstream 5ec6baa40 introduced multi-project boards. Resolution
// chain for the *default-active* board mirrors
// hermes_cli/kanban_db.py:
//   HERMES_KANBAN_BOARD env → <root>/kanban/current file → "default".
// The 'default' board keeps its legacy DB path <root>/kanban.db and
// legacy logs dir <root>/kanban/logs/; every other board lives at
// <root>/kanban/boards/<slug>/{kanban.db,logs/}.
//
// Herm renders all boards at once; the "current" board only seeds
// which section has focus on mount. Reads are sidecar SQLite per
// board (WAL lets us read alongside the dispatcher's IMMEDIATE write
// txns). Writes split by verb:
//
//   Structured transitions → shell.exec → `hermes kanban --board
//   <slug> <verb>` (complete/block/unblock/archive/assign/link/
//   unlink/edit/dispatch). kanban_db.py owns the state machine —
//   run closure, recompute_ready, notify-sub fanout.
//
//   Field edits (title/body/priority) → direct bun:sqlite writes in
//   a BEGIN IMMEDIATE txn, mirroring plugins/kanban/dashboard/
//   plugin_api.py PATCH /tasks/:id. Every raw write appends a
//   matching task_events row inside the same txn so the audit
//   trail and dashboard live feed stay intact. This pattern is
//   deliberately scoped to the same fields the dashboard edits
//   directly; tenant/workspace/skills/max_runtime stay
//   create-time-only.

import { Database } from "bun:sqlite"
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs"
import { hermesPath } from "./hermes-home"

export const STATUSES = ["triage", "todo", "ready", "running", "blocked", "done"] as const
export type Status = typeof STATUSES[number]

export type Task = {
  id: string; title: string; body: string | null
  assignee: string | null; status: Status; priority: number
  created_at: number; updated_at: number; completed_at: number | null
  result: string | null; error: string | null
  tenant: string | null; pid: number | null
  workspace_kind: string | null; workspace_path: string | null
  skills: string[]
  max_runtime_seconds: number | null
  review_required: boolean; review_count: number
}

export type Run = {
  id: number; profile: string | null
  status: string | null; outcome: string | null
  started_at: number; ended_at: number | null
  summary: string | null; error: string | null
  worker_pid: number | null
}

export type Event = {
  id: number; kind: string
  payload: unknown | null
  created_at: number
  run_id: number | null
}

export type Detail = Task & {
  parents: string[]; children: string[]
  comments: Array<{ author: string; body: string; at: number }>
  runs: Run[]
  events: Event[]
  latest_summary: string | null
}

export type Board = { slug: string; name: string }

const DEFAULT = "default"
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Active board slug per the CLI's resolution chain. Herm shows every
 *  board; this only picks which section is focused on mount. */
const resolve = (): string => {
  const env = (process.env.HERMES_KANBAN_BOARD ?? "").trim().toLowerCase()
  if (SLUG.test(env)) return env
  try {
    const txt = readFileSync(hermesPath("kanban/current"), "utf-8").trim().toLowerCase()
    if (SLUG.test(txt)) return txt
  } catch {}
  return DEFAULT
}

let slug = resolve()

/** Two cached handles per board slug: [ro, rw]. `null` = open attempted
 *  and failed (no DB yet); `undefined` = not yet attempted. Separate
 *  handles because bun:sqlite's readonly flag is per-connection and we
 *  want reads to never block on a write handle taking the lock. */
type Handles = { ro: Database | null; rw: Database | null }
const handles = new Map<string, Handles>()

export const currentBoard = () => slug

/** default keeps legacy <root>/kanban.db; others live under boards/<slug>/. */
const dbPath = (s: string) =>
  hermesPath(s === DEFAULT ? "kanban.db" : `kanban/boards/${s}/kanban.db`)

const logsDir = (s: string) =>
  hermesPath(s === DEFAULT ? "kanban/logs" : `kanban/boards/${s}/logs`)

const pair = (s: string): Handles => {
  const cached = handles.get(s)
  if (cached) return cached
  const next: Handles = { ro: null, rw: null }
  handles.set(s, next)
  return next
}

const dbOf = (s: string): Database | null => {
  const h = pair(s)
  if (h.ro !== null) return h.ro
  try { h.ro = new Database(dbPath(s), { readonly: true }) } catch { h.ro = null }
  return h.ro
}

/** Open (or return) a read-write handle for `s`. WAL mode matches the
 *  dispatcher so readers and this writer can coexist. Returns null if
 *  the DB file doesn't exist yet (create via `hermes kanban init` or
 *  the first CLI create). */
const rwOf = (s: string): Database | null => {
  const h = pair(s)
  if (h.rw) return h.rw
  if (!existsSync(dbPath(s))) return null
  try {
    const db = new Database(dbPath(s))
    // Match kanban_db.connect() pragmas. WAL is a no-op after the first
    // time but cheap; synchronous=NORMAL matches upstream.
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON")
    h.rw = db
    return db
  } catch { return null }
}

/** Close every cached handle and re-resolve the active board.
 *  Call after a profile rehome, board create, or test seeding. */
export const resetKanban = () => {
  for (const h of handles.values()) { h.ro?.close(); h.rw?.close() }
  handles.clear()
  slug = resolve()
}

/** Enumerate boards on disk. 'default' always first; others sorted. */
export function listBoards(): Board[] {
  const out = new Map<string, string>([[DEFAULT, "Default"]])
  const dir = hermesPath("kanban/boards")
  if (existsSync(dir))
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !SLUG.test(e.name)) continue
      let name = e.name
      try {
        const meta = JSON.parse(readFileSync(`${dir}/${e.name}/board.json`, "utf-8"))
        // Upstream writes "name" (hermes_cli/kanban_db.py write_board_metadata);
        // older installs may have "display_name". Accept either.
        const n = typeof meta?.name === "string" ? meta.name
          : typeof meta?.display_name === "string" ? meta.display_name : null
        if (n) name = n
      } catch {}
      out.set(e.name, name)
    }
  return [...out].map(([s, n]) => ({ slug: s, name: n }))
    .sort((a, b) => a.slug === DEFAULT ? -1 : b.slug === DEFAULT ? 1 : a.slug.localeCompare(b.slug))
}

// completed_at / started_at / created_at → updated_at proxy. The
// tasks table has no updated_at; newest-of-the-three is close enough
// for sort-by-recency without joining task_events on every list.
const AT = "COALESCE(completed_at, started_at, created_at)"

/** Schema on a live DB can lag the current upstream migrations —
 *  tests seed a minimal table, ancient installs may not have run
 *  `kanban init`. Query `PRAGMA table_info` once per handle and
 *  expose a set so `boardOf`/`detailOf` can COALESCE optional
 *  columns to NULL without exploding. */
const cols = new WeakMap<Database, Set<string>>()
const colsOf = (conn: Database): Set<string> => {
  const cached = cols.get(conn)
  if (cached) return cached
  const set = new Set<string>()
  try {
    for (const r of conn.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>)
      set.add(r.name)
  } catch {}
  cols.set(conn, set)
  return set
}

/** Build a select clause that emits NULL for any column not present
 *  on the current schema. Keeps old test DBs + fresh-install DBs
 *  working without branching at every call site. */
const selectCol = (have: Set<string>, name: string, alias?: string): string => {
  const a = alias ?? name
  return have.has(name) ? `${name} AS ${a}` : `NULL AS ${a}`
}

const taskColumns = (have: Set<string>): string => [
  "id", "title", selectCol(have, "body"), selectCol(have, "assignee"),
  "status", "priority", selectCol(have, "tenant"),
  selectCol(have, "created_at"), selectCol(have, "completed_at"),
  selectCol(have, "result"), selectCol(have, "last_spawn_error"),
  selectCol(have, "worker_pid"),
  selectCol(have, "workspace_kind"), selectCol(have, "workspace_path"),
  selectCol(have, "skills"), selectCol(have, "max_runtime_seconds"),
  `${AT} AS updated_at`,
].join(", ")

const parseSkills = (raw: unknown): string[] => {
  if (typeof raw !== "string" || !raw) return []
  try {
    const j = JSON.parse(raw)
    return Array.isArray(j) ? j.filter((v): v is string => typeof v === "string" && !!v) : []
  } catch { return [] }
}

const toTask = (r: Record<string, unknown>): Task => ({
  id: String(r.id), title: String(r.title ?? ""),
  body: (r.body as string) ?? null,
  assignee: (r.assignee as string) ?? null,
  status: (r.status as Status) ?? "todo",
  priority: Number(r.priority) || 0,
  created_at: Number(r.created_at) || 0,
  updated_at: Number(r.updated_at) || 0,
  completed_at: (r.completed_at as number) ?? null,
  result: (r.result as string) ?? null,
  error: (r.last_spawn_error as string) ?? null,
  tenant: (r.tenant as string) ?? null,
  pid: (r.worker_pid as number) ?? null,
  workspace_kind: (r.workspace_kind as string) ?? null,
  workspace_path: (r.workspace_path as string) ?? null,
  skills: parseSkills(r.skills),
  max_runtime_seconds: (r.max_runtime_seconds as number) ?? null,
  review_required: Boolean(r.review_required),
  review_count: Number(r.review_count) || 0,
})

const reviewOf = (conn: Database): Map<string, number> => {
  try {
    const rows = conn.query(
      `SELECT task_id, COUNT(*) AS n FROM task_comments
       WHERE lower(body) LIKE '%review-required%'
       GROUP BY task_id`,
    ).all() as Array<{ task_id: string; n: number }>
    return new Map(rows.map(r => [r.task_id, Number(r.n) || 1]))
  } catch { return new Map() }
}

const markReview = (t: Task, m: Map<string, number>): Task => {
  const n = m.get(t.id) ?? 0
  if (!n) return t
  return { ...t, review_required: true, review_count: n }
}

const toRun = (r: Record<string, unknown>): Run => ({
  id: Number(r.id),
  profile: (r.profile as string) ?? null,
  status: (r.status as string) ?? null,
  outcome: (r.outcome as string) ?? null,
  started_at: Number(r.started_at) || 0,
  ended_at: (r.ended_at as number) ?? null,
  summary: (r.summary as string) ?? null,
  error: (r.error as string) ?? null,
  worker_pid: (r.worker_pid as number) ?? null,
})

const toEvent = (r: Record<string, unknown>): Event => {
  const raw = r.payload as string | null
  let payload: unknown = null
  if (raw) try { payload = JSON.parse(raw) } catch { payload = raw }
  return {
    id: Number(r.id),
    kind: String(r.kind ?? ""),
    payload,
    created_at: Number(r.created_at) || 0,
    run_id: (r.run_id as number) ?? null,
  }
}

/** All non-archived tasks on `s`, grouped by status column. Each
 *  column sorted by (priority desc, updated_at desc) so the
 *  dispatcher's pick-next ordering roughly matches the top of
 *  `ready`. */
export function boardOf(s: string): Map<Status, Task[]> {
  const out = new Map<Status, Task[]>(STATUSES.map(k => [k, []]))
  const conn = dbOf(s)
  if (!conn) return out
  try {
    const rows = conn.query(
      `SELECT ${taskColumns(colsOf(conn))}
       FROM tasks WHERE status != 'archived'
       ORDER BY priority DESC, updated_at DESC`,
    ).all() as Array<Record<string, unknown>>
    const reviews = reviewOf(conn)
    for (const r of rows) {
      const t = markReview(toTask(r), reviews)
      out.get(t.status)?.push(t)
    }
  } catch {}
  return out
}

const EVENT_TAIL = 20

export function detailOf(s: string, id: string): Detail | null {
  const conn = dbOf(s)
  if (!conn) return null
  try {
    const row = conn.query(
      `SELECT ${taskColumns(colsOf(conn))} FROM tasks WHERE id = ?`,
    ).get(id) as Record<string, unknown> | null
    if (!row) return null
    const parents = (conn.query(
      "SELECT parent_id FROM task_links WHERE child_id = ?",
    ).all(id) as Array<{ parent_id: string }>).map(r => r.parent_id)
    const children = (conn.query(
      "SELECT child_id FROM task_links WHERE parent_id = ?",
    ).all(id) as Array<{ child_id: string }>).map(r => r.child_id)
    const comments = (conn.query(
      "SELECT author, body, created_at FROM task_comments WHERE task_id = ? ORDER BY created_at",
    ).all(id) as Array<{ author: string; body: string; created_at: number }>)
      .map(c => ({ author: c.author, body: c.body, at: c.created_at }))
    // task_runs / task_events may not exist on ancient DBs; swallow and
    // return [] so the detail pane keeps working.
    const runs = runsOf(conn, id)
    const events = eventsOf(conn, id)
    const latest = latestSummary(conn, id)
    return {
      ...markReview(toTask(row), reviewOf(conn)), parents, children, comments,
      runs, events, latest_summary: latest,
    }
  } catch { return null }
}

const runsOf = (conn: Database, id: string): Run[] => {
  try {
    return (conn.query(
      `SELECT id, profile, status, outcome, started_at, ended_at,
              summary, error, worker_pid
       FROM task_runs WHERE task_id = ? ORDER BY id`,
    ).all(id) as Array<Record<string, unknown>>).map(toRun)
  } catch { return [] }
}

const eventsOf = (conn: Database, id: string): Event[] => {
  try {
    // Newest-20 DESC from SQL, then reverse so callers see chronological
    // order (matches `hermes kanban show` last-20-events output).
    const rows = conn.query(
      `SELECT id, kind, payload, created_at, run_id
       FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?`,
    ).all(id, EVENT_TAIL) as Array<Record<string, unknown>>
    return rows.map(toEvent).reverse()
  } catch { return [] }
}

const latestSummary = (conn: Database, id: string): string | null => {
  try {
    const row = conn.query(
      `SELECT summary FROM task_runs
       WHERE task_id = ? AND summary IS NOT NULL AND summary != ''
       ORDER BY id DESC LIMIT 1`,
    ).get(id) as { summary: string } | null
    return row?.summary ?? null
  } catch { return null }
}

/** Tail of the worker log. Mirrors kanban_db.read_worker_log's
 *  seek-from-end + skip-partial-line. */
export function tailLogOf(s: string, id: string, bytes = 16_384): string | null {
  const path = `${logsDir(s)}/${id}.log`
  if (!existsSync(path)) return null
  try {
    const size = statSync(path).size
    const want = Math.min(size, bytes)
    const fd = openSync(path, "r")
    const buf = Buffer.alloc(want)
    readSync(fd, buf, 0, want, size - want)
    closeSync(fd)
    let out = buf.toString("utf-8")
    if (size > bytes) {
      const nl = out.indexOf("\n")
      if (nl >= 0 && nl < out.length - 1) out = out.slice(nl + 1)
    }
    return out
  } catch { return null }
}

/** Candidate assignee names — profiles-on-disk ∪ any assignee
 *  referenced on board `s` (a task can be assigned to a profile that
 *  no longer exists; show it so the operator can reassign *away*). */
export function assignees(s: string = slug): string[] {
  const seen = new Set<string>()
  const dir = hermesPath("profiles")
  if (existsSync(dir))
    for (const e of readdirSync(dir, { withFileTypes: true }))
      if (e.isDirectory()) seen.add(e.name)
  const conn = dbOf(s)
  if (conn) try {
    for (const r of conn.query(
      "SELECT DISTINCT assignee FROM tasks WHERE assignee IS NOT NULL AND status != 'archived'",
    ).all() as Array<{ assignee: string }>) seen.add(r.assignee)
  } catch {}
  return [...seen].sort()
}

// ── Direct writes ──────────────────────────────────────────────────
// Scoped to the same field set plugins/kanban/dashboard/plugin_api.py
// PATCH /tasks/:id writes directly: title, body, priority. Every raw
// write is wrapped in BEGIN IMMEDIATE and followed by a task_events
// row in the same transaction so the audit trail stays intact.
//
// NOTE: status transitions are deliberately NOT here — use the CLI
// verbs (complete/block/unblock/archive) which close runs, emit
// notify-subs, and recompute_ready on children. The dashboard's
// _set_status_direct helper exists for drag-drop between non-terminal
// states only; herm doesn't have a drag affordance, so the simpler
// "verbs for status, raw for fields" split is enough.

/** Wrap `fn` in a BEGIN IMMEDIATE txn on `conn`. Mirrors
 *  kanban_db.write_txn — IMMEDIATE takes the reserved lock up front so
 *  concurrent writers fail fast instead of racing mid-txn. */
function writeTxn<T>(conn: Database, fn: () => T): T {
  conn.exec("BEGIN IMMEDIATE")
  try {
    const out = fn()
    conn.exec("COMMIT")
    return out
  } catch (err) {
    try { conn.exec("ROLLBACK") } catch {}
    throw err
  }
}

const now = () => Math.floor(Date.now() / 1000)

export type PatchFields = {
  title?: string
  body?: string | null
  priority?: number
}

/** Apply `patch` to task `id` on board `s`. Returns true on success,
 *  false if the task doesn't exist. Throws on malformed input (empty
 *  title, DB error). Mirrors the dashboard's PATCH /tasks/:id write
 *  discipline: one txn per field group, matching event kind. */
export function patchTask(s: string, id: string, patch: PatchFields): boolean {
  const conn = rwOf(s)
  if (!conn) return false

  const exists = conn.query("SELECT 1 FROM tasks WHERE id = ?").get(id) as unknown
  if (!exists) return false

  // Priority first (dashboard orders it this way; each field is its
  // own sub-txn so partial failures surface per-field).
  if (patch.priority !== undefined) {
    const p = Math.max(0, Math.min(9, Math.floor(patch.priority)))
    writeTxn(conn, () => {
      conn.query("UPDATE tasks SET priority = ? WHERE id = ?").run(p, id)
      conn.query(
        "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) " +
        "VALUES (?, NULL, 'reprioritized', ?, ?)",
      ).run(id, JSON.stringify({ priority: p }), now())
    })
  }

  if (patch.title !== undefined || patch.body !== undefined) {
    const sets: string[] = []
    const vals: Array<string | null> = []
    if (patch.title !== undefined) {
      const t = patch.title.trim()
      if (!t) throw new Error("title cannot be empty")
      sets.push("title = ?"); vals.push(t)
    }
    if (patch.body !== undefined) {
      sets.push("body = ?"); vals.push(patch.body)
    }
    vals.push(id)
    writeTxn(conn, () => {
      conn.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
      conn.query(
        "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) " +
        "VALUES (?, NULL, 'edited', NULL, ?)",
      ).run(id, now())
    })
  }

  return true
}

// ── Current-board shims ────────────────────────────────────────────
// Kept for callers that don't care about multi-board (rehome, tests).

export const board = () => boardOf(slug)
export const detail = (id: string) => detailOf(slug, id)
export const tailLog = (id: string, bytes?: number) => tailLogOf(slug, id, bytes)

/** POSIX single-quote for shell.exec argv building. Wraps only when
 *  the string contains shell metacharacters (keeps test assertions
 *  and toast messages readable for plain ids). */
export const q = (s: string): string =>
  /^[A-Za-z0-9._\/:+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
