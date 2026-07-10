import { Database } from "bun:sqlite"
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs"

const DEFAULT_BUSY_TIMEOUT_MS = 120_000
const BUSY_RETRIES = 5
const BUSY_BUDGET_MS = 5_000
const BUSY_MIN_MS = 20
const BUSY_MAX_MS = 150
const handles = new Map<string, { db: Database; ino: number }>()

export type PatchFields = {
  title?: string
  body?: string | null
  priority?: number
}

const timeout = () => {
  const raw = (process.env.HERMES_KANBAN_BUSY_TIMEOUT_MS ?? "").trim()
  if (!raw) return DEFAULT_BUSY_TIMEOUT_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BUSY_TIMEOUT_MS
}

const busy = (err: unknown) => {
  const msg = String((err as Error)?.message ?? err).toLowerCase()
  return msg.includes("database is locked") || msg.includes("database is busy")
}

const nap = () => {
  const ms = BUSY_MIN_MS + Math.random() * (BUSY_MAX_MS - BUSY_MIN_MS)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const boundary = (db: Pick<Database, "exec">, sql: "BEGIN IMMEDIATE" | "COMMIT") => {
  const attempts = Math.max(1, Math.min(BUSY_RETRIES + 1, Math.ceil(BUSY_BUDGET_MS / timeout())))
  for (let i = 0; i < attempts; i++) {
    try { db.exec(sql); return }
    catch (err) {
      if (!busy(err) || i === attempts - 1) throw err
      nap()
    }
  }
}

const pathOf = (root: string, board: string) =>
  `${root.replace(/[\\/]+$/, "")}/${board === "default" ? "kanban.db" : `kanban/boards/${board}/kanban.db`}`

const open = (root: string, board: string) => {
  const path = pathOf(root, board)
  const cached = handles.get(path)
  const ino = (() => {
    try { return statSync(path).ino }
    catch { return null }
  })()
  if (cached?.ino === ino) return cached.db
  if (cached) {
    cached.db.close()
    handles.delete(path)
  }
  if (ino === null) return null
  try {
    const db = new Database(path)
    db.exec(`PRAGMA busy_timeout=${timeout()}`)
    try { db.exec("PRAGMA journal_mode=WAL") } catch {}
    db.exec([
      "PRAGMA synchronous=FULL",
      "PRAGMA wal_autocheckpoint=100",
      "PRAGMA secure_delete=ON",
      "PRAGMA cell_size_check=ON",
      "PRAGMA foreign_keys=ON",
    ].join(";"))
    handles.set(path, { db, ino })
    return db
  } catch {
    return null
  }
}

const check = (db: Database) => {
  try {
    const row = db.query("PRAGMA database_list").get() as Record<string, unknown> | null
    const path = String(row?.file ?? row?.[2] ?? "")
    if (!path) return
    const page = db.query("PRAGMA page_size").get() as Record<string, unknown> | null
    const size = Number(Object.values(page ?? {})[0])
    if (!size) return
    const fd = openSync(path, "r")
    try {
      const buf = Buffer.alloc(4)
      if (readSync(fd, buf, 0, 4, 28) < 4) return
      const header = buf.readUInt32BE(0)
      if (!header) return
      const actual = Math.floor(fstatSync(fd).size / size)
      if (actual < header)
        throw new Error(`torn-extend detected: page count mismatch on ${path}: header claims ${header} pages, file has ${actual} pages`)
    } finally { closeSync(fd) }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("torn-extend detected")) throw err
  }
}

function writeTxn<T>(db: Database, fn: () => T): T {
  boundary(db, "BEGIN IMMEDIATE")
  const out = (() => {
    try { return fn() }
    catch (err) {
      try { db.exec("ROLLBACK") } catch {}
      throw err
    }
  })()
  try { boundary(db, "COMMIT") }
  catch (err) {
    try { db.exec("ROLLBACK") } catch {}
    throw err
  }
  check(db)
  return out
}

export function patchAt(root: string, board: string, id: string, patch: PatchFields): boolean {
  const db = open(root, board)
  if (!db) return false
  if (!db.query("SELECT 1 FROM tasks WHERE id = ?").get(id)) return false

  const priority = patch.priority === undefined
    ? undefined
    : Math.max(0, Math.min(9, Math.floor(patch.priority)))
  const sets: string[] = []
  const vals: Array<string | null> = []
  if (patch.title !== undefined) {
    const title = patch.title.trim()
    if (!title) throw new Error("title cannot be empty")
    sets.push("title = ?")
    vals.push(title)
  }
  if (patch.body !== undefined) {
    sets.push("body = ?")
    vals.push(patch.body)
  }
  if (priority === undefined && sets.length === 0) return true

  writeTxn(db, () => {
    if (priority !== undefined) {
      db.query("UPDATE tasks SET priority = ? WHERE id = ?").run(priority, id)
      db.query(
        "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) VALUES (?, NULL, 'reprioritized', ?, ?)",
      ).run(id, JSON.stringify({ priority }), Math.floor(Date.now() / 1000))
    }
    if (sets.length > 0) {
      db.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id)
      db.query(
        "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) VALUES (?, NULL, 'edited', NULL, ?)",
      ).run(id, Math.floor(Date.now() / 1000))
    }
  })
  return true
}

export function writePragmas(root: string, board: string): Record<string, string | number | null> | null {
  const db = open(root, board)
  if (!db) return null
  const read = (sql: string) => {
    const row = db.query(sql).get() as Record<string, unknown> | null
    const value = Object.values(row ?? {})[0]
    return typeof value === "string" || typeof value === "number" ? value : null
  }
  return {
    journal_mode: read("PRAGMA journal_mode"),
    synchronous: read("PRAGMA synchronous"),
    wal_autocheckpoint: read("PRAGMA wal_autocheckpoint"),
    busy_timeout: read("PRAGMA busy_timeout"),
    secure_delete: read("PRAGMA secure_delete"),
    cell_size_check: read("PRAGMA cell_size_check"),
    foreign_keys: read("PRAGMA foreign_keys"),
  }
}

export function resetWrites(): void {
  for (const handle of handles.values()) handle.db.close()
  handles.clear()
}

export const internals = { writeTxn }
