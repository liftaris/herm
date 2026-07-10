import { describe, test, expect, beforeAll, afterEach, spyOn } from "bun:test"
import { act } from "react"
import { Database } from "bun:sqlite"
import { mkdirSync, writeFileSync, rmSync, chmodSync, renameSync } from "node:fs"
import { join } from "node:path"
import { mountNode, MockGateway, until } from "./harness"
import { hermesPath } from "../src/service/hermes-home"
import {
  board, boardOf, detail, detailOf, assignees, tailLog, q, resetKanban,
  currentBoard, listBoards, parseDiagnostics, maxSeverity, sortDiags,
  boardStateOf, boardErrors, corruptBackupsOf,
} from "../src/service/hermes-kanban"
import { parseDispatchResult, dispatchFailures, dispatchVariant, dispatchDetails } from "../src/service/kanban-dispatch"
import { Kanban } from "../src/tabs/Kanban"
import { patchAt, resetWrites } from "../src/service/kanban-write"

const now = Math.floor(Date.now() / 1000)

const schema = (db: Database) => {
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, title TEXT, body TEXT, assignee TEXT,
    status TEXT, priority INTEGER DEFAULT 0, tenant TEXT,
    block_kind TEXT, block_recurrences INTEGER DEFAULT 0,
    created_at INTEGER, started_at INTEGER, completed_at INTEGER,
    result TEXT, last_spawn_error TEXT, worker_pid INTEGER,
    workspace_kind TEXT, workspace_path TEXT,
    skills TEXT, max_runtime_seconds INTEGER
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS task_links (
    parent_id TEXT, child_id TEXT, PRIMARY KEY (parent_id, child_id))`)
  db.run(`CREATE TABLE IF NOT EXISTS task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT,
    author TEXT, body TEXT, created_at INTEGER)`)
  // Append-only audit tables. kanban_db.py writes to these on every
  // write; herm reads them for the detail pane's Runs/Events sections
  // and the patchTask event-row sibling INSERTs.
  db.run(`CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, run_id INTEGER,
    kind TEXT, payload TEXT, created_at INTEGER)`)
  db.run(`CREATE TABLE IF NOT EXISTS task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, profile TEXT,
    status TEXT, outcome TEXT, started_at INTEGER, ended_at INTEGER,
    summary TEXT, error TEXT, worker_pid INTEGER)`)
  db.run(`CREATE TABLE IF NOT EXISTS task_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT,
    filename TEXT, stored_path TEXT, content_type TEXT,
    size INTEGER, uploaded_by TEXT, created_at INTEGER)`)
}


const cleanupHazardBoards = () => {
  for (const slug of ["bad", "missing", "old", "quarantined", "ui_bad", "unreadable"])
    rmSync(hermesPath(`kanban/boards/${slug}`), { recursive: true, force: true })
  rmSync(hermesPath("kanban.db.corrupt.20260527_010204.bak"), { force: true })
  try {
    const db = new Database(hermesPath("kanban.db"))
    db.run("UPDATE tasks SET block_kind = NULL, block_recurrences = 0")
    db.close()
  } catch {}
  resetKanban()
}

afterEach(() => cleanupHazardBoards())

beforeAll(() => {
  delete process.env.HERMES_KANBAN_BOARD
  mkdirSync(hermesPath("."), { recursive: true })
  mkdirSync(hermesPath("profiles/researcher"), { recursive: true })
  mkdirSync(hermesPath("profiles/writer"), { recursive: true })
  mkdirSync(hermesPath("kanban/logs"), { recursive: true })
  // Scrub boards from prior failed runs before seeding.
  rmSync(hermesPath("kanban/boards"), { recursive: true, force: true })
  rmSync(hermesPath("kanban/current"), { force: true })
  writeFileSync(hermesPath("kanban/logs/t2.log"), "boot\nstep 1\nstep 2\n")
  const db = new Database(hermesPath("kanban.db"), { create: true })
  schema(db)
  const ins = db.prepare(
    `INSERT OR REPLACE INTO tasks (id, title, body, assignee, status,
       priority, created_at, started_at, completed_at, result, worker_pid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  ins.run("t1", "research cost", "Compare infra costs", "researcher",
    "ready", 3, now - 3600, null, null, null, null)
  ins.run("t2", "research perf", null, "researcher",
    "running", 3, now - 1800, now - 60, null, null, 4242)
  ins.run("t3", "synthesize", "merge findings", "analyst",
    "todo", 2, now - 900, null, null, null, null)
  ins.run("t4", "draft memo", null, "writer",
    "done", 1, now - 7200, now - 7100, now - 7000, "memo.md written", null)
  ins.run("t5", "need decision", "rate limit keying", "researcher",
    "blocked", 2, now - 600, now - 500, null, null, null)
  ins.run("t0", "one-liner idea", null, null,
    "triage", 0, now - 200, null, null, null, null)
  db.run("INSERT INTO task_links (parent_id, child_id) VALUES ('t1','t3'),('t2','t3')")
  db.run("INSERT INTO task_comments (task_id, author, body, created_at) VALUES (?,?,?,?)",
    ["t1", "kaio", "check AWS reserved pricing too", now - 1000])
  mkdirSync(hermesPath("kanban/attachments/t1"), { recursive: true })
  const defaultBlob = hermesPath("kanban/attachments/t1/spec.pdf")
  writeFileSync(defaultBlob, "pdf bytes")
  db.run(`INSERT INTO task_attachments
    (task_id, filename, stored_path, content_type, size, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["t1", "spec.pdf", defaultBlob, "application/pdf", 9, "kaio", now - 900])
  db.close()

  // Second board with its own DB + log dir, and board.json metadata.
  mkdirSync(hermesPath("kanban/boards/atm10/logs"), { recursive: true })
  writeFileSync(hermesPath("kanban/boards/atm10/board.json"),
    JSON.stringify({ display_name: "ATM10 Server" }))
  writeFileSync(hermesPath("kanban/boards/atm10/logs/m1.log"), "mod boot\n")
  const db2 = new Database(hermesPath("kanban/boards/atm10/kanban.db"), { create: true })
  schema(db2)
  db2.run(
    `INSERT INTO tasks (id, title, status, priority, created_at)
     VALUES ('m1', 'upgrade forge', 'ready', 1, ?)`, [now - 100],
  )
  mkdirSync(hermesPath("kanban/boards/atm10/attachments/m1"), { recursive: true })
  const boardBlob = hermesPath("kanban/boards/atm10/attachments/m1/modpack.txt")
  writeFileSync(boardBlob, "modpack")
  db2.run(`INSERT INTO task_attachments
    (task_id, filename, stored_path, content_type, size, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["m1", "modpack.txt", boardBlob, "text/plain", 7, "kaio", now - 50])
  db2.close()
  // Third board — empty, exercises collapsed-by-default + empty-last sort.
  mkdirSync(hermesPath("kanban/boards/zeta"), { recursive: true })
  resetKanban()
})

describe("hermes-kanban readers", () => {
  test("board() groups by status, sorted by priority desc", () => {
    const b = board()
    expect(b.get("ready")?.[0]?.id).toBe("t1")
    expect(b.get("running")?.[0]?.pid).toBe(4242)
    expect(b.get("todo")?.[0]?.id).toBe("t3")
    expect(b.get("blocked")?.[0]?.id).toBe("t5")
    expect(b.get("done")?.[0]?.result).toContain("memo.md")
    expect(b.get("triage")?.[0]?.id).toBe("t0")
  })

  test("boardOf() reads per-slug without touching current", () => {
    expect(currentBoard()).toBe("default")
    expect(boardOf("atm10").get("ready")?.[0]?.id).toBe("m1")
    expect(boardOf("default").get("ready")?.[0]?.id).toBe("t1")
    expect([...boardOf("zeta").values()].every(v => v.length === 0)).toBe(true)
  })

  test("boardOf() reads typed block state when present and tolerates old schema", () => {
    const db = new Database(hermesPath("kanban.db"))
    db.run("UPDATE tasks SET block_kind = 'needs_input', block_recurrences = 2 WHERE id = 't5'")
    db.close()
    resetKanban()

    const blocked = boardOf("default").get("blocked")?.find(t => t.id === "t5")
    expect(blocked?.block_kind).toBe("needs_input")
    expect(blocked?.block_recurrences).toBe(2)

    mkdirSync(hermesPath("kanban/boards/old"), { recursive: true })
    const old = new Database(hermesPath("kanban/boards/old/kanban.db"), { create: true })
    old.run(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT, body TEXT, assignee TEXT,
      status TEXT, priority INTEGER DEFAULT 0, created_at INTEGER,
      started_at INTEGER, completed_at INTEGER
    )`)
    old.run("INSERT INTO tasks (id, title, status, priority, created_at) VALUES ('old1', 'legacy board', 'ready', 1, ?)", [now])
    old.close()
    resetKanban()

    const legacy = boardOf("old").get("ready")?.[0]
    expect(legacy?.id).toBe("old1")
    expect(legacy?.block_kind).toBeNull()
    expect(legacy?.block_recurrences).toBe(0)
  })


  test("boardStateOf() keeps missing DB empty but reports corrupt existing DB", () => {
    rmSync(hermesPath("kanban/boards/missing"), { recursive: true, force: true })
    mkdirSync(hermesPath("kanban/boards/missing"), { recursive: true })
    resetKanban()

    const missing = boardStateOf("missing")
    expect(missing.error).toBeNull()
    expect([...missing.columns.values()].every(v => v.length === 0)).toBe(true)

    mkdirSync(hermesPath("kanban/boards/bad"), { recursive: true })
    writeFileSync(hermesPath("kanban/boards/bad/kanban.db"), "not sqlite\n")
    resetKanban()

    const bad = boardStateOf("bad")
    expect(bad.error?.kind).toBe("corrupt")
    expect(bad.error?.path).toContain("kanban/boards/bad/kanban.db")
    expect(bad.error?.message).toContain("invalid SQLite header")
    expect([...bad.columns.values()].every(v => v.length === 0)).toBe(true)
  })

  test("boardStateOf() reports unreadable existing DB separately from missing DB", () => {
    mkdirSync(hermesPath("kanban/boards/unreadable"), { recursive: true })
    writeFileSync(hermesPath("kanban/boards/unreadable/kanban.db"), "SQLite format 3\0")
    chmodSync(hermesPath("kanban/boards/unreadable/kanban.db"), 0o000)
    resetKanban()
    try {
      const unreadable = boardStateOf("unreadable")
      expect(unreadable.error).not.toBeNull()
      expect(unreadable.error?.kind).not.toBe("missing")
      expect(unreadable.error?.path).toContain("kanban/boards/unreadable/kanban.db")
    } finally {
      chmodSync(hermesPath("kanban/boards/unreadable/kanban.db"), 0o600)
    }
  })

  test("boardErrors() and corruptBackupsOf() expose board-level DB hazards", () => {
    mkdirSync(hermesPath("kanban/boards/bad"), { recursive: true })
    writeFileSync(hermesPath("kanban/boards/bad/kanban.db"), "not sqlite\n")
    mkdirSync(hermesPath("kanban/boards/quarantined"), { recursive: true })
    writeFileSync(hermesPath("kanban/boards/quarantined/kanban.db.corrupt.20260527_010203.bak"), "old bytes")
    writeFileSync(hermesPath("kanban.db.corrupt.20260527_010204.bak"), "old default bytes")
    resetKanban()

    const qs = corruptBackupsOf("quarantined")
    const ds = corruptBackupsOf("default")
    expect(qs.some(p => p.endsWith("kanban.db.corrupt.20260527_010203.bak"))).toBe(true)
    expect(ds.some(p => p.endsWith("kanban.db.corrupt.20260527_010204.bak"))).toBe(true)
    expect(boardErrors().some(e => e.slug === "bad" && e.error.kind === "corrupt")).toBe(true)
  })

  test("detail() hydrates parents/children/comments", () => {
    const d = detail("t3")!
    expect(d.parents.sort()).toEqual(["t1", "t2"])
    expect(d.children).toEqual([])
    const d1 = detail("t1")!
    expect(d1.children).toEqual(["t3"])
    expect(d1.comments[0].body).toContain("AWS reserved")
    expect(d.attachments).toEqual([])
  })

  test("detail() hydrates safe attachment metadata", () => {
    const d = detail("t1")!
    expect(d.attachments).toEqual([{
      id: 1,
      filename: "spec.pdf",
      name: "spec.pdf",
      size: 9,
      created_at: now - 900,
      stored_path: hermesPath("kanban/attachments/t1/spec.pdf"),
      relative_path: "t1/spec.pdf",
      path: hermesPath("kanban/attachments/t1/spec.pdf"),
    }])
  })

  test("detailOf() uses the selected board attachment root", () => {
    const d = detailOf("atm10", "m1")!
    expect(d.attachments[0].path).toBe(hermesPath("kanban/boards/atm10/attachments/m1/modpack.txt"))
  })

  test("detailOf() validates stored paths against the attachment root", () => {
    const db = new Database(hermesPath("kanban.db"))
    db.run(`INSERT INTO task_attachments
      (task_id, filename, stored_path, content_type, size, uploaded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["t1", "passwd", "/etc/passwd", "text/plain", 123, "evil", now - 800])
    db.close()
    resetKanban()

    const bad = detail("t1")!.attachments.find(a => a.filename === "passwd")!
    expect(bad.path).toBeNull()
    expect(bad.relative_path).toBeNull()
    expect(bad.stored_path).toBe("/etc/passwd")
  })

  test("detailOf() respects HERMES_KANBAN_ATTACHMENTS_ROOT", () => {
    const root = hermesPath("custom-attachments")
    mkdirSync(join(root, "t1"), { recursive: true })
    const custom = join(root, "t1", "custom.txt")
    writeFileSync(custom, "custom")
    const db = new Database(hermesPath("kanban.db"))
    db.run(`INSERT INTO task_attachments
      (task_id, filename, stored_path, content_type, size, uploaded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["t1", "custom.txt", custom, "text/plain", 6, "kaio", now - 700])
    db.close()
    process.env.HERMES_KANBAN_ATTACHMENTS_ROOT = root
    resetKanban()
    try {
      const d = detail("t1")!
      expect(d.attachments.find(a => a.filename === "custom.txt")?.path).toBe(custom)
      expect(d.attachments.find(a => a.filename === "spec.pdf")?.path).toBeNull()
    } finally {
      delete process.env.HERMES_KANBAN_ATTACHMENTS_ROOT
      resetKanban()
    }
  })

  test("assignees() = profiles-on-disk ∪ board assignees", () => {
    const a = assignees()
    expect(a).toContain("researcher")
    expect(a).toContain("writer")
    expect(a).toContain("analyst") // not on disk, only on board
  })

  test("tailLog() seeks from end and skips partial line", () => {
    expect(tailLog("t2")).toContain("step 2")
    expect(tailLog("t2", 10)).not.toContain("boot")
    expect(tailLog("t1")).toBeNull()
  })

  test("q() leaves plain ids, quotes metacharacters", () => {
    expect(q("t1")).toBe("t1")
    expect(q("hello world")).toBe("'hello world'")
    expect(q("it's")).toBe(`'it'\\''s'`)
  })

  test("listBoards() always leads with default; reads board.json display_name", () => {
    const bs = listBoards()
    expect(bs[0].slug).toBe("default")
    const atm = bs.find(b => b.slug === "atm10")
    expect(atm?.name).toBe("ATM10 Server")
    expect(bs.find(b => b.slug === "zeta")).toBeTruthy()
  })

  test("board resolution: env → current file → default", () => {
    expect(currentBoard()).toBe("default")
    process.env.HERMES_KANBAN_BOARD = "atm10"
    resetKanban()
    expect(currentBoard()).toBe("atm10")
    expect(board().get("ready")?.[0]?.id).toBe("m1")
    delete process.env.HERMES_KANBAN_BOARD
    writeFileSync(hermesPath("kanban/current"), "atm10\n")
    resetKanban()
    expect(currentBoard()).toBe("atm10")
    rmSync(hermesPath("kanban/current"), { force: true })
    resetKanban()
    expect(currentBoard()).toBe("default")
    expect(board().get("ready")?.[0]?.id).toBe("t1")
  })
})

describe("Kanban tab", () => {
  test("column wheel scroll does not move outer board scroll", async () => {
    const db = new Database(hermesPath("kanban.db"), { create: true })
    const ins = db.prepare(
      "INSERT INTO tasks (id, title, status, priority, created_at) VALUES (?, ?, 'ready', 1, ?)",
    )
    for (let i = 0; i < 30; i++)
      ins.run(`long${i}`, `long ready ${i.toString().padStart(2, "0")}`, now - i)
    db.close()
    resetKanban()

    const t = await mountNode(<Kanban focused />, { width: 180, height: 24 })
    try {
      await until(t, () => t.frame().includes("long ready 00"))
      type Node = {
        id?: string; x: number; y: number; scrollTop: number; scrollHeight: number
        viewport: { height: number }; getChildren?: () => unknown[]
      }
      const root = (t.renderer as unknown as { root: unknown }).root
      const find = (node: unknown, id: string): Partial<Node> | null => {
        const n = node as Partial<Node>
        if (n.id === id) return n
        for (const c of n.getChildren?.() ?? []) {
          const r = find(c, id)
          if (r) return r
        }
        return null
      }
      const outer = find(root, "kb-board-scroll") as Node | null
      const col = find(root, "kb-col-default-ready") as Node | null
      if (!outer || !col) throw new Error("scrollbox probe missing")
      expect(col.scrollHeight).toBeGreaterThan(col.viewport.height)
      expect(outer.scrollHeight).toBeGreaterThan(outer.viewport.height)
      const top = outer.scrollTop
      await act(async () => { await t.mouse.scroll(col.x + 1, col.y + 1, "down") })
      await t.settle()
      expect(col.scrollTop).toBeGreaterThan(0)
      expect(outer.scrollTop).toBe(top)
    } finally {
      t.destroy()
      const db = new Database(hermesPath("kanban.db"))
      db.run("DELETE FROM tasks WHERE id LIKE 'long%'")
      db.close()
      resetKanban()
    }
  })

  test("stacks boards, empty last, chips + one-line rows", async () => {
    const t = await mountNode(<Kanban focused />, { width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards · 7 tasks"))
    const f = t.frame()
    // Non-empty boards open; empty board collapsed and sorted last.
    expect(f).toContain("▾ Default")
    expect(f).toContain("▾ ATM10 Server")
    expect(f).toMatch(/▸ zeta\s+·\s+empty/)
    const lines = f.split("\n")
    expect(lines.findIndex(l => l.includes("ATM10 Server")))
      .toBeLessThan(lines.findIndex(l => l.includes("zeta")))
    // Filter chip row on default: assignees, priorities, then status.
    const chipLine = lines.find(l => /\banalyst\b/.test(l) && /\bP3\b/.test(l))!
    expect(chipLine).toContain("researcher")
    expect(chipLine).toContain("writer")
    expect(chipLine).toContain("P2")
    // Status chips always present, in STATUSES order.
    expect(chipLine).toMatch(/triage\s+todo\s+scheduled\s+ready\s+running\s+blocked\s+done/)
    // atm10 has no assignees — its chip row is priority + status only.
    expect(f).not.toMatch(/ATM10 Server[\s\S]*?\n.*researcher.*\n/)
    // One-line cards: title renders, meta line does not.
    expect(f).toContain("research cost")
    expect(f).toContain("upgrade forge")
    expect(f).not.toMatch(/t2\s+researcher\s+P3/)
    t.destroy()
  })


  test("renders corrupt DB as a board error instead of an empty create prompt", async () => {
    mkdirSync(hermesPath("kanban/boards/ui_bad"), { recursive: true })
    writeFileSync(hermesPath("kanban/boards/ui_bad/board.json"), JSON.stringify({ name: "Bad Board" }))
    writeFileSync(hermesPath("kanban/boards/ui_bad/kanban.db"), "broken board bytes")
    resetKanban()

    const t = await mountNode(<Kanban focused />, { width: 180, height: 44 })
    try {
      await until(t, () => t.frame().includes("Bad Board"))
      const f = t.frame()
      expect(f).toMatch(/Bad Board\s+·\s+corrupt/)
      expect(f).toContain("Kanban DB corrupt")
      expect(f).toContain("invalid SQLite header")
      expect(f).not.toMatch(/Bad Board[\s\S]*no tasks —/)
    } finally {
      t.destroy()
    }
  })

  test("arrows nav within board; Enter → detail pane", async () => {
    const t = await mountNode(<Kanban focused />, { width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    // Initial tier = grid on current board. → → → to 'ready' (col 3
    // at full width: triage, todo, scheduled, ready).
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => /Assignee\s+researcher/.test(t.frame()))
    expect(t.frame()).toMatch(/Children\s+t3/)
    expect(t.frame()).toContain("spec.pdf")
    expect(t.frame()).not.toContain(hermesPath("kanban/attachments/t1/spec.pdf"))
    expect(t.frame()).toContain("AWS reserved")
    expect(t.frame()).toMatch(/a assign\s+c comment\s+u unblock/)
    act(() => t.keys.pressEscape())
    await until(t, () => !/Assignee\s+researcher/.test(t.frame()))
    t.destroy()
  })

  test("Tab walks boards; verbs pin --board to active section", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { if (!/\bdiagnostics\b/.test(p.command as string)) cmds.push(p.command as string); return { stdout: "", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("▾ Default"))
    expect(t.frame()).toContain("Tab board")
    // Tab → atm10; hint switches to head-tier wording.
    act(() => t.keys.pressTab()); await t.settle()
    await until(t, () => t.frame().includes("Space fold"))
    // ↓↓ descends filter → grid; →→→ to 'ready' on atm10 (col 3).
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    await until(t, () => /d archive/.test(t.frame()))
    await act(async () => { await t.keys.typeText("d") })
    await until(t, () => t.frame().includes("Archive task?"))
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => cmds.length === 1)
    expect(cmds[0]).toBe("hermes kanban --board atm10 archive m1")
    // Shift+Tab → back to default head.
    act(() => t.keys.pressTab({ shift: true })); await t.settle()
    await until(t, () => t.frame().includes("Space fold"))
    t.destroy()
  })

  test("Space is context-sensitive: head folds, filter toggles, grid no-op", async () => {
    const t = await mountNode(<Kanban focused />, { width: 180, height: 44 })
    await until(t, () => t.frame().includes("▾ Default"))
    // Start in grid — Space does nothing (Default stays open).
    act(() => t.keys.pressKey(" ")); await t.settle()
    expect(t.frame()).toContain("▾ Default")
    // ↑ to filter tier. Space cycles first chip (analyst): off→in→ex→off.
    act(() => t.keys.pressArrow("up")); await t.settle()
    await until(t, () => t.frame().includes("←→ chip"))
    act(() => t.keys.pressKey(" "))
    await until(t, () => t.frame().includes("1/6 task"))
    // include: only analyst's task survives the who group.
    expect(t.frame()).toContain("synthesize")
    expect(t.frame()).not.toContain("research cost")
    act(() => t.keys.pressKey(" "))
    await until(t, () => t.frame().includes("5/6 task"))
    // exclude: everyone except analyst.
    expect(t.frame()).not.toContain("synthesize")
    expect(t.frame()).toContain("research cost")
    act(() => t.keys.pressKey(" "))
    await until(t, () => !/\d\/6 task/.test(t.frame()))
    // ↑ to head. Space collapses.
    act(() => t.keys.pressArrow("up")); await t.settle()
    await until(t, () => t.frame().includes("Space fold"))
    act(() => t.keys.pressKey(" "))
    await until(t, () => t.frame().includes("▸ Default"))
    expect(t.frame()).not.toContain("research cost")
    expect(t.frame()).toContain("upgrade forge") // atm10 still open
    act(() => t.keys.pressKey(" "))
    await until(t, () => t.frame().includes("▾ Default"))
    t.destroy()
  })

  test("a → DialogSelect → shell.exec assign", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { if (!/\bdiagnostics\b/.test(p.command as string)) cmds.push(p.command as string); return { stdout: "", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    await act(async () => { await t.keys.typeText("a") })
    await until(t, () => t.frame().includes("Assign t1"))
    await act(async () => { await t.keys.typeText("writer") })
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => cmds.length > 0)
    expect(cmds[0]).toBe("hermes kanban --board default assign t1 writer")
    t.destroy()
  })

  test("u on blocked → comment then unblock", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { if (!/\bdiagnostics\b/.test(p.command as string)) cmds.push(p.command as string); return { stdout: "", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    for (let i = 0; i < 5; i++) { act(() => t.keys.pressArrow("right")); await t.settle() }
    await act(async () => { await t.keys.typeText("u") })
    await until(t, () => t.frame().includes("Unblock t5"))
    await act(async () => { await t.keys.typeText("use user_id") })
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => cmds.length === 2)
    expect(cmds[0]).toBe("hermes kanban --board default comment t5 'use user_id' --author user")
    expect(cmds[1]).toBe("hermes kanban --board default unblock t5")
    t.destroy()
  })

  test("status editor uses typed --kind when active CLI supports it", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => {
        const cmd = p.command as string
        if (/\bdiagnostics\b/.test(cmd)) return { stdout: "", stderr: "", code: 0 }
        cmds.push(cmd)
        if (/\bblock --help$/.test(cmd)) return { stdout: "usage: hermes kanban block [--kind KIND]", stderr: "", code: 0 }
        return { stdout: "", stderr: "", code: 0 }
      },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    try {
      await until(t, () => t.frame().includes("Kanban · 3 boards"))
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressEnter())
      await until(t, () => /Status\s+ready/.test(t.frame()))
      act(() => t.keys.pressTab()); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressEnter())
      await until(t, () => t.frame().includes("Status for t1"))
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressEnter())
      await until(t, () => t.frame().includes("Block kind for t1"))
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressEnter())
      await until(t, () => t.frame().includes("Block t1"))
      await act(async () => { await t.keys.typeText("need answer") })
      act(() => t.keys.pressEnter())
      await until(t, () => cmds.length === 2)
      expect(cmds[0]).toBe("hermes kanban --board default block --help")
      expect(cmds[1]).toBe("hermes kanban --board default block t1 'need answer' --kind needs_input")
    } finally {
      t.destroy()
    }
  })

  test("status editor falls back to generic block when active CLI lacks --kind", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => {
        const cmd = p.command as string
        if (/\bdiagnostics\b/.test(cmd)) return { stdout: "", stderr: "", code: 0 }
        cmds.push(cmd)
        if (/\bblock --help$/.test(cmd)) return { stdout: "usage: hermes kanban block task_id [reason ...] [--ids IDS]", stderr: "", code: 0 }
        return { stdout: "", stderr: "", code: 0 }
      },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    try {
      await until(t, () => t.frame().includes("Kanban · 3 boards"))
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressEnter())
      await until(t, () => /Status\s+ready/.test(t.frame()))
      act(() => t.keys.pressTab()); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressEnter())
      await until(t, () => t.frame().includes("Status for t1"))
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressEnter())
      await until(t, () => t.frame().includes("generic block"))
      await act(async () => { await t.keys.typeText("need answer") })
      act(() => t.keys.pressEnter())
      await until(t, () => cmds.length === 2)
      expect(cmds[0]).toBe("hermes kanban --board default block --help")
      expect(cmds[1]).toBe("hermes kanban --board default block t1 'need answer'")
    } finally {
      t.destroy()
    }
  })

  test("status editor sends dependency kind when active CLI supports typed blocks", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => {
        const cmd = p.command as string
        if (/\bdiagnostics\b/.test(cmd)) return { stdout: "", stderr: "", code: 0 }
        cmds.push(cmd)
        if (/\bblock --help$/.test(cmd)) return { stdout: "usage: hermes kanban block [--kind KIND]", stderr: "", code: 0 }
        return { stdout: "", stderr: "", code: 0 }
      },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    try {
      await until(t, () => t.frame().includes("Kanban · 3 boards"))
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressEnter())
      await until(t, () => /Status\s+ready/.test(t.frame()))
      act(() => t.keys.pressTab()); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressEnter())
      await until(t, () => t.frame().includes("Status for t1"))
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressEnter())
      await until(t, () => t.frame().includes("Block kind for t1"))
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressEnter())
      await until(t, () => t.frame().includes("Block t1"))
      await act(async () => { await t.keys.typeText("waiting on t3") })
      act(() => t.keys.pressEnter())
      await until(t, () => cmds.length === 2)
      expect(cmds[1]).toBe("hermes kanban --board default block t1 'waiting on t3' --kind dependency")
    } finally {
      t.destroy()
    }
  })

  test("d → confirm → archive", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { if (!/\bdiagnostics\b/.test(p.command as string)) cmds.push(p.command as string); return { stdout: "", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    for (let i = 0; i < 6; i++) { act(() => t.keys.pressArrow("right")); await t.settle() }
    await act(async () => { await t.keys.typeText("d") })
    await until(t, () => t.frame().includes("Archive task?"))
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => cmds.length === 1)
    expect(cmds[0]).toBe("hermes kanban --board default archive t4")
    t.destroy()
  })

  test("s on triage → shell.exec specify → success toast with new title", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => {
        if (!/\bdiagnostics\b/.test(p.command as string)) cmds.push(p.command as string)
        return { stdout: `{"task_id":"t0","ok":true,"reason":null,"new_title":"Expanded idea"}\n`, stderr: "", code: 0 }
      },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    // Initial col 0 = triage, row 0 = t0. `s` fires specify.
    await act(async () => { await t.keys.typeText("s") })
    await until(t, () => cmds.length === 1)
    expect(cmds[0]).toBe("hermes kanban --board default specify t0 --json")
    await until(t, () => /Specified t0 → Expanded idea/.test(t.frame()))
    t.destroy()
  })

  test("s on non-triage is a no-op (info toast, no command)", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { if (!/\bdiagnostics\b/.test(p.command as string)) cmds.push(p.command as string); return { stdout: "", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    // → to 'todo' (col 1) — t3 is not triage.
    act(() => t.keys.pressArrow("right")); await t.settle()
    await act(async () => { await t.keys.typeText("s") })
    await t.settle()
    // when-guard keeps the action from firing; no shell command emitted.
    expect(cmds.length).toBe(0)
    t.destroy()
  })

  test("S → confirm → specify --all → aggregate toast", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => {
        if (!/\bdiagnostics\b/.test(p.command as string)) cmds.push(p.command as string)
        return {
          stdout:
            `{"task_id":"t0","ok":true,"reason":null,"new_title":"First spec"}\n`
            + `{"task_id":"tX","ok":false,"reason":"auxiliary: timeout","new_title":null}\n`,
          stderr: "", code: 0,
        }
      },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("S") })
    await until(t, () => t.frame().includes("Specify all"))
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => cmds.length === 1)
    expect(cmds[0]).toBe("hermes kanban --board default specify --all --json")
    await until(t, () => /Specified 1\/2 \(1 failed\)/.test(t.frame()))
    t.destroy()
  })

  test("n → create dialog → shell.exec create on active board", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { if (!/\bdiagnostics\b/.test(p.command as string)) cmds.push(p.command as string); return { stdout: "t6", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("n") })
    await until(t, () => t.frame().includes("New Task"))
    await act(async () => { await t.keys.typeText("ship rate limiter") })
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => cmds.length === 1)
    expect(cmds[0]).toBe("hermes kanban --board default create 'ship rate limiter'")
    t.destroy()
  })

  test("create form: empty title blocks submit; footer nags", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { if (!/\bdiagnostics\b/.test(p.command as string)) cmds.push(p.command as string); return { stdout: "x", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("n") })
    await until(t, () => t.frame().includes("New Task"))
    // No title typed. Enter is a no-op; Ctrl+Enter is a no-op.
    expect(t.frame()).toContain("type a title")
    act(() => t.keys.pressEnter())
    act(() => t.keys.pressEnter({ ctrl: true }))
    await t.settle()
    expect(cmds.length).toBe(0)
    expect(t.frame()).toContain("New Task") // still open
    t.destroy()
  })

  test("create form: ↓ walks fields; Space toggles triage; Ctrl+Enter submits", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { if (!/\bdiagnostics\b/.test(p.command as string)) cmds.push(p.command as string); return { stdout: "t7", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("n") })
    await until(t, () => t.frame().includes("New Task"))
    await act(async () => { await t.keys.typeText("spike the thing") })
    await t.settle()
    // title → body (empty, ↓ escapes) → assignee → priority → triage
    act(() => t.keys.pressArrow("down")); await t.settle() // body
    act(() => t.keys.pressArrow("down")); await t.settle() // assignee
    act(() => t.keys.pressArrow("down")); await t.settle() // priority
    act(() => t.keys.pressArrow("down")); await t.settle() // triage
    await until(t, () => /▸ Triage/.test(t.frame()))
    await act(async () => { await t.keys.typeText(" ") })
    await until(t, () => /Triage\s+yes/.test(t.frame()))
    act(() => t.keys.pressEnter({ ctrl: true }))
    await until(t, () => cmds.length === 1)
    expect(cmds[0]).toBe("hermes kanban --board default create 'spike the thing' --triage")
    t.destroy()
  })

  test("create form: Space on Assignee opens picker; selection feeds --assignee", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { if (!/\bdiagnostics\b/.test(p.command as string)) cmds.push(p.command as string); return { stdout: "t8", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("n") })
    await until(t, () => t.frame().includes("New Task"))
    await act(async () => { await t.keys.typeText("needs an owner") })
    await t.settle()
    act(() => t.keys.pressArrow("down")); await t.settle() // body
    act(() => t.keys.pressArrow("down")); await t.settle() // assignee
    await until(t, () => /▸ Assignee/.test(t.frame()))
    await act(async () => { await t.keys.typeText(" ") })   // open picker
    await until(t, () => /Search profiles/.test(t.frame()))
    // ↓ past "(unassigned)" to the first real profile, Enter.
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressEnter()); await t.settle()
    await until(t, () => /▸ Assignee\s+\S/.test(t.frame()) && !/\(unassigned\)/.test(t.frame().split("Assignee")[1] ?? ""))
    act(() => t.keys.pressEnter({ ctrl: true }))
    await until(t, () => cmds.length === 1)
    expect(cmds[0]).toMatch(/^hermes kanban --board default create 'needs an owner' --assignee \S+$/)
    t.destroy()
  })

  test("create form: body textarea — ↓ enters, Enter newlines, Tab leaves; body feeds --body", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { if (!/\bdiagnostics\b/.test(p.command as string)) cmds.push(p.command as string); return { stdout: "t9", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("n") })
    await until(t, () => t.frame().includes("New Task"))
    await act(async () => { await t.keys.typeText("has a body") })
    await t.settle()
    act(() => t.keys.pressArrow("down")); await t.settle() // into body
    await until(t, () => /▸ Body/.test(t.frame()))
    await act(async () => { await t.keys.typeText("para one") })
    act(() => t.keys.pressEnter())                          // newline (not submit)
    await act(async () => { await t.keys.typeText("para two") })
    await t.settle()
    expect(cmds.length).toBe(0)                             // Enter did NOT submit
    expect(t.frame()).toContain("para one")
    expect(t.frame()).toContain("para two")
    act(() => t.keys.pressTab()); await t.settle()          // Tab leaves body → assignee
    await until(t, () => /▸ Assignee/.test(t.frame()))
    act(() => t.keys.pressEnter({ ctrl: true }))
    await until(t, () => cmds.length === 1)
    expect(cmds[0]).toBe("hermes kanban --board default create 'has a body' --body 'para one\npara two'")
    t.destroy()
  })

  test("create form: ↑/↓ in a multi-line body move the cursor, only escape at the edges", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { if (!/\bdiagnostics\b/.test(p.command as string)) cmds.push(p.command as string); return { stdout: "tb", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("n") })
    await until(t, () => t.frame().includes("New Task"))
    await act(async () => { await t.keys.typeText("multiline body") })
    await t.settle()
    act(() => t.keys.pressArrow("down")); await t.settle() // into body (empty → enters)
    await until(t, () => /▸ Body/.test(t.frame()))
    // Three lines; cursor ends on line 3 (last).
    await act(async () => { await t.keys.typeText("one") })
    act(() => t.keys.pressEnter())
    await act(async () => { await t.keys.typeText("two") })
    act(() => t.keys.pressEnter())
    await act(async () => { await t.keys.typeText("three") })
    await t.settle()
    // ↑ twice: cursor row 2 → 1 → 0. Focus must stay on Body.
    act(() => t.keys.pressArrow("up")); await t.settle()
    expect(t.frame()).toMatch(/▸ Body/)
    act(() => t.keys.pressArrow("up")); await t.settle()
    expect(t.frame()).toMatch(/▸ Body/)
    // Now at row 0 — one more ↑ spills over to the previous field (Title).
    act(() => t.keys.pressArrow("up")); await t.settle()
    expect(t.frame()).toMatch(/▸ Title/)
    // ↓ from Title re-enters Body at row 0; ↓ again stays (row 0 → 1), etc.
    act(() => t.keys.pressArrow("down")); await t.settle()
    expect(t.frame()).toMatch(/▸ Body/)
    act(() => t.keys.pressArrow("down")); await t.settle() // row 0 → 1
    expect(t.frame()).toMatch(/▸ Body/)
    act(() => t.keys.pressArrow("down")); await t.settle() // row 1 → 2 (last)
    expect(t.frame()).toMatch(/▸ Body/)
    // row 2 is the last line — one more ↓ spills to the next field (Assignee).
    act(() => t.keys.pressArrow("down")); await t.settle()
    expect(t.frame()).toMatch(/▸ Assignee/)
    // Body text survived all of that.
    act(() => t.keys.pressEnter({ ctrl: true }))
    await until(t, () => cmds.length === 1)
    expect(cmds[0]).toBe("hermes kanban --board default create 'multiline body' --body 'one\ntwo\nthree'")
    t.destroy()
  })

  test("create form: More section hidden until expanded; Workspace dir: → --workspace dir:<path>", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { if (!/\bdiagnostics\b/.test(p.command as string)) cmds.push(p.command as string); return { stdout: "t10", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("n") })
    await until(t, () => t.frame().includes("New Task"))
    await act(async () => { await t.keys.typeText("in a dir") })
    await t.settle()
    expect(t.frame()).not.toContain("Workspace") // collapsed
    // title→body→assignee→priority→triage→more
    for (let i = 0; i < 5; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    await until(t, () => /▸ More/.test(t.frame()))
    await act(async () => { await t.keys.typeText(" ") })   // expand
    await until(t, () => /Workspace/.test(t.frame()))
    // more→tenant→project→workspace
    act(() => t.keys.pressArrow("down")); await t.settle() // tenant
    act(() => t.keys.pressArrow("down")); await t.settle() // project
    act(() => t.keys.pressArrow("down")); await t.settle() // workspace
    await until(t, () => /▸ Workspace/.test(t.frame()))
    await act(async () => { await t.keys.typeText(" ") })   // open workspace picker
    await until(t, () => /isolated temp dir under the board root/.test(t.frame()))
    // scratch (0), worktree (1), dir (2) — ↓↓ to dir, Enter → path prompt
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressEnter()); await t.settle()
    await until(t, () => /Directory path/.test(t.frame()))
    await act(async () => { await t.keys.typeText("/tmp/work") })
    await t.settle()
    act(() => t.keys.pressEnter()); await t.settle()        // confirm path
    await until(t, () => /Workspace\s+dir @ \/tmp\/work/.test(t.frame()))
    act(() => t.keys.pressEnter({ ctrl: true }))
    await until(t, () => cmds.length === 1)
    expect(cmds[0]).toBe("hermes kanban --board default create 'in a dir' --workspace dir:/tmp/work")
    t.destroy()
  })

  test("create form: Project field feeds --project", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { if (!/\bdiagnostics\b/.test(p.command as string)) cmds.push(p.command as string); return { stdout: "tp", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("n") })
    await until(t, () => t.frame().includes("New Task"))
    await act(async () => { await t.keys.typeText("linked task") })
    await t.settle()
    for (let i = 0; i < 5; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    await act(async () => { await t.keys.typeText(" ") })
    await until(t, () => /Project/.test(t.frame()))
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressArrow("down")); await t.settle()
    await until(t, () => /▸ Project/.test(t.frame()))
    await act(async () => { await t.keys.typeText("herm") })
    await t.settle()
    act(() => t.keys.pressEnter({ ctrl: true }))
    await until(t, () => cmds.length === 1)
    expect(cmds[0]).toBe("hermes kanban --board default create 'linked task' --project herm")
    t.destroy()
  })

  test("create form: Esc cancels — no command", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { if (!/\bdiagnostics\b/.test(p.command as string)) cmds.push(p.command as string); return { stdout: "x", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("n") })
    await until(t, () => t.frame().includes("New Task"))
    await act(async () => { await t.keys.typeText("never mind") })
    await t.settle()
    act(() => t.keys.pressEscape())
    await until(t, () => !t.frame().includes("New Task"))
    expect(cmds.length).toBe(0)
    t.destroy()
  })

  test("create form: Esc in a picker returns to the form, not out", async () => {
    const t = await mountNode(<Kanban focused />, { width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("n") })
    await until(t, () => t.frame().includes("New Task"))
    await act(async () => { await t.keys.typeText("keep me") })
    await t.settle()
    act(() => t.keys.pressArrow("down")); await t.settle() // body
    act(() => t.keys.pressArrow("down")); await t.settle() // assignee
    await until(t, () => /▸ Assignee/.test(t.frame()))
    await act(async () => { await t.keys.typeText(" ") })   // open assignee picker
    await until(t, () => /Search profiles/.test(t.frame()))
    act(() => t.keys.pressEscape()); await t.settle()       // Esc → back to form
    expect(t.frame()).toContain("New Task")                 // form still open
    expect(t.frame()).not.toMatch(/Search profiles/)        // picker closed
    expect(t.frame()).toContain("keep me")                  // title preserved
    // Esc again on the bare form → closes creation.
    act(() => t.keys.pressEscape())
    await until(t, () => !t.frame().includes("New Task"))
    t.destroy()
  })

  test("create form: Esc in dir-path prompt backs to the workspace picker", async () => {
    const t = await mountNode(<Kanban focused />, { width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("n") })
    await until(t, () => t.frame().includes("New Task"))
    await act(async () => { await t.keys.typeText("nested esc") })
    await t.settle()
    for (let i = 0; i < 5; i++) { act(() => t.keys.pressArrow("down")); await t.settle() } // → More
    await act(async () => { await t.keys.typeText(" ") })   // expand
    await until(t, () => /Workspace/.test(t.frame()))
    act(() => t.keys.pressArrow("down")); await t.settle() // tenant
    act(() => t.keys.pressArrow("down")); await t.settle() // project
    act(() => t.keys.pressArrow("down")); await t.settle() // workspace
    await act(async () => { await t.keys.typeText(" ") })   // open workspace picker
    await until(t, () => /isolated temp dir under the board root/.test(t.frame()))
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressArrow("down")); await t.settle() // → dir:…
    act(() => t.keys.pressEnter()); await t.settle()       // → dir-path prompt
    await until(t, () => /Directory path/.test(t.frame()))
    act(() => t.keys.pressEscape()); await t.settle()      // Esc → back to workspace picker
    expect(t.frame()).toMatch(/isolated temp dir under the board root/)
    act(() => t.keys.pressEscape()); await t.settle()      // Esc → back to form
    expect(t.frame()).toContain("New Task")
    expect(t.frame()).not.toMatch(/isolated temp dir under the board root/)
    t.destroy()
  })

  test("create form: Priority picker is filter-free; Space selects", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { if (!/\bdiagnostics\b/.test(p.command as string)) cmds.push(p.command as string); return { stdout: "tp", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("n") })
    await until(t, () => t.frame().includes("New Task"))
    await act(async () => { await t.keys.typeText("prio pick") })
    await t.settle()
    act(() => t.keys.pressArrow("down")); await t.settle() // body
    act(() => t.keys.pressArrow("down")); await t.settle() // assignee
    act(() => t.keys.pressArrow("down")); await t.settle() // priority
    await until(t, () => /▸ Priority/.test(t.frame()))
    await act(async () => { await t.keys.typeText(" ") })   // open priority picker
    await until(t, () => /P0 \(none\)/.test(t.frame()))
    // No filter input — typing a digit must NOT filter; it is ignored.
    expect(t.frame()).not.toMatch(/Type to filter/)
    // ↓↓↓ to P3, Space selects (not just Enter).
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressArrow("down")); await t.settle()
    await act(async () => { await t.keys.typeText(" ") })   // Space = select
    await until(t, () => /▸ Priority\s+P3/.test(t.frame()))
    act(() => t.keys.pressEnter({ ctrl: true }))
    await until(t, () => cmds.length === 1)
    expect(cmds[0]).toBe("hermes kanban --board default create 'prio pick' --priority 3")
    t.destroy()
  })

  test("D → confirm → dispatch parses telemetry", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => {
        if (!/\bdiagnostics\b/.test(p.command as string)) cmds.push(p.command as string)
        return { stdout: JSON.stringify({
          reclaimed: 0,
          promoted: 1,
          spawned: [{ task_id: "t1", assignee: "researcher", workspace: "/tmp/w" }],
          auto_assigned_default: ["t6"],
          skipped_per_profile_capped: [{ task_id: "t7", assignee: "researcher", current: 2 }],
          skipped_unassigned: [],
          skipped_nonspawnable: [],
          crashed: [],
          auto_blocked: [],
          timed_out: [],
          stale: [],
        }), stderr: "", code: 0 }
      },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("D") })
    await until(t, () => t.frame().includes("Dispatch · default"))
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => cmds.length === 1)
    expect(cmds[0]).toBe("hermes kanban --board default dispatch --json")
    await until(t, () => t.frame().includes("Dispatch: 1 spawned · 1 defaulted · 1 deferred"))
    t.destroy()
  })

  test("D → confirm → dispatch surfaces unassigned separately", async () => {
    const gw = new MockGateway({
      "shell.exec": p => /\bdiagnostics\b/.test(p.command as string)
        ? { stdout: "[]", stderr: "", code: 0 }
        : { stdout: JSON.stringify({
          spawned: [],
          skipped_unassigned: ["t8"],
          skipped_nonspawnable: [],
          skipped_per_profile_capped: [],
          auto_assigned_default: [],
          crashed: [],
          auto_blocked: [],
          timed_out: [],
          stale: [],
        }), stderr: "", code: 0 },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("D") })
    await until(t, () => t.frame().includes("Dispatch · default"))
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => t.frame().includes("Dispatch: 0 spawned · 1 unassigned"))
    expect(t.frame()).not.toContain("skipped")
    t.destroy()
  })

  test("D → confirm → dispatch shows failed instead of skipped when no worker spawns", async () => {
    const gw = new MockGateway({
      "shell.exec": p => /\bdiagnostics\b/.test(p.command as string)
        ? { stdout: "[]", stderr: "", code: 0 }
        : { stdout: JSON.stringify({
          spawned: [],
          skipped_unassigned: [],
          skipped_nonspawnable: [],
          skipped_per_profile_capped: [],
          auto_assigned_default: [],
          crashed: ["t8"],
          auto_blocked: [],
          timed_out: ["t9"],
          stale: [],
        }), stderr: "", code: 0 },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("D") })
    await until(t, () => t.frame().includes("Dispatch · default"))
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => t.frame().includes("Dispatch: 0 spawned · 2 failed"))
    expect(t.frame()).not.toContain("skipped")
    t.destroy()
  })

  test("D → confirm → dispatch separates benign and failure labels", async () => {
    const gw = new MockGateway({
      "shell.exec": p => /\bdiagnostics\b/.test(p.command as string)
        ? { stdout: "[]", stderr: "", code: 0 }
        : { stdout: JSON.stringify({
          spawned: [{ task_id: "t1", assignee: "builder", workspace: "/tmp/w" }],
          skipped_unassigned: [],
          skipped_nonspawnable: [],
          skipped_per_profile_capped: [{ task_id: "t3", assignee: "researcher", current: 2 }],
          auto_assigned_default: [],
          crashed: ["t6"],
          auto_blocked: [],
          timed_out: [],
          stale: [],
          respawn_guarded: [],
        }), stderr: "", code: 0 },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("D") })
    await until(t, () => t.frame().includes("Dispatch · default"))
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => t.frame().includes("Dispatch: 1 spawned · 1 deferred · 1 failed"))
    expect(t.frame()).not.toContain("skipped")
    t.destroy()
  })

  test("D → confirm → malformed dispatch json surfaces error toast", async () => {
    const gw = new MockGateway({
      "shell.exec": p => /\bdiagnostics\b/.test(p.command as string)
        ? { stdout: "[]", stderr: "", code: 0 }
        : { stdout: "not json", stderr: "", code: 0 },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("D") })
    await until(t, () => t.frame().includes("Dispatch · default"))
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => t.frame().includes("JSON Parse error"))
    t.destroy()
  })

  test("dispatch parser defaults new buckets and separates dispatch variants", () => {
    const old = parseDispatchResult(JSON.stringify({
      reclaimed: 0,
      promoted: 0,
      spawned: [{ task_id: "t1", assignee: "builder", workspace: "" }],
      skipped_unassigned: ["t2"],
      skipped_nonspawnable: ["t3"],
      crashed: [],
      auto_blocked: [],
      timed_out: [],
      stale: [],
    }))
    expect(old.auto_assigned_default).toEqual([])
    expect(old.skipped_per_profile_capped).toEqual([])

    const cur = parseDispatchResult(JSON.stringify({
      spawned: [{ task_id: "t1", assignee: "builder", workspace: "" }],
      skipped_per_profile_capped: [{ task_id: "t4", assignee: "builder", current: 1 }],
      auto_assigned_default: ["t5"],
      crashed: ["t6"],
    }))
    expect(cur.skipped_per_profile_capped).toEqual([{ task_id: "t4", assignee: "builder", current: 1 }])
    expect(cur.auto_assigned_default).toEqual(["t5"])
    expect(dispatchFailures(cur)).toEqual(["t6"])
    expect(dispatchVariant(cur)).toBe("warning")
    expect(dispatchVariant(parseDispatchResult(JSON.stringify({ spawned: [], crashed: ["t6"] })))).toBe("error")
    expect(dispatchVariant(parseDispatchResult(JSON.stringify({ spawned: [], skipped_per_profile_capped: [{ task_id: "t4", assignee: "builder", current: 1 }] })))).toBe("info")
    expect(dispatchVariant(parseDispatchResult(JSON.stringify({ spawned: [{ task_id: "t1", assignee: "builder", workspace: "" }], auto_assigned_default: ["t5"] })))).toBe("success")
    expect(dispatchDetails(parseDispatchResult(JSON.stringify({
      auto_assigned_default: ["t5"],
      skipped_per_profile_capped: [{ task_id: "t4", assignee: "builder", current: 1 }],
      skipped_unassigned: ["t2"],
      skipped_nonspawnable: ["t3"],
      crashed: ["t6"],
      respawn_guarded: [["t7", "active_pr"]],
    })))).toBe([
      "Defaulted to kanban.default_assignee: t5",
      "Deferred at per-profile cap:",
      "  builder (1 running): t4",
      "Unassigned: t2",
      "Non-spawnable lanes: t3",
      "Failed/reclaimed · crashed: t6",
      "Respawn guarded: t7 (active_pr)",
    ].join("\n"))
    expect(() => parseDispatchResult("not json")).toThrow()
  })

  test("l opens log pane; Esc closes", async () => {
    const t = await mountNode(<Kanban focused />, { width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    for (let i = 0; i < 4; i++) { act(() => t.keys.pressArrow("right")); await t.settle() }
    await act(async () => { await t.keys.typeText("l") })
    await until(t, () => t.frame().includes("worker log (tail)"))
    expect(t.frame()).toContain("step 2")
    act(() => t.keys.pressEscape())
    await until(t, () => !t.frame().includes("worker log (tail)"))
    t.destroy()
  })

  test("non-zero exit surfaces as error toast, no crash", async () => {
    const gw = new MockGateway({
      "shell.exec": () => ({ stdout: "", stderr: "cycle detected: t1 → t3 → t1", code: 2 }),
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    await act(async () => { await t.keys.typeText("a") })
    await until(t, () => t.frame().includes("Assign t1"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("cycle detected"))
    t.destroy()
  })

  test("↓ walks off the last row into the next board's head", async () => {
    const t = await mountNode(<Kanban focused />, { width: 180, height: 48 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    // Grid on default, col 0 (triage, 1 task). → to todo (1 task); its
    // single row then walks off into atm10 head on the next ↓.
    act(() => t.keys.pressArrow("right")); await t.settle()
    // row 0 → ↓ crosses into atm10 head.
    act(() => t.keys.pressArrow("down")); await t.settle()
    await until(t, () => t.frame().includes("Space fold"))
    // ↓↓ → filter → grid on atm10; → → to ready (col 3 → col on atm10
    // stays where default left it = 1, so 2 rights advances to col 3).
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    await until(t, () => /d archive/.test(t.frame()))
    // ↑ back through tiers returns to default's grid (same column preserved).
    for (let i = 0; i < 3; i++) { act(() => t.keys.pressArrow("up")); await t.settle() }
    // atm10 head → default bottom: tier=grid, column clamped.
    await until(t, () => /Enter detail/.test(t.frame()))
    t.destroy()
  })

  test("dialog open ⇒ underlying tab ignores nav keys", async () => {
    const t = await mountNode(<Kanban focused />, { width: 180, height: 48 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    // →→→ to 'ready' on Default; open detail on t1.
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => /Assignee\s+researcher/.test(t.frame()))
    // N → create-child popup.
    await act(async () => { await t.keys.typeText("N") })
    await until(t, () => t.frame().includes("child of t1"))
    // ↑↑↓ after the popup has painted. If the underlying handler
    // leaked, the first ↑ would move tier=filter and the
    // detail-follows effect would close the side pane.
    act(() => t.keys.pressArrow("up")); await t.settle()
    act(() => t.keys.pressArrow("up")); await t.settle()
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressEscape())
    await until(t, () => !t.frame().includes("child of t1"))
    expect(t.frame()).toMatch(/Assignee\s+researcher/)
    expect(t.frame()).toMatch(/Children\s+t3/)
    t.destroy()
  })

  test("status chip tri-state: include → only that col; exclude → drops it", async () => {
    const t = await mountNode(<Kanban focused />, { width: 180, height: 48 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    // Lines between Default's header and ATM10's header.
    const slice = () => {
      const ls = t.frame().split("\n")
      const a = ls.findIndex(l => l.includes("▾ Default"))
      const b = ls.findIndex(l => l.includes("ATM10 Server"))
      return ls.slice(a, b).join("\n")
    }
    // ↑ to filter tier; → past who(3)+pri(3)+triage onto status: todo.
    act(() => t.keys.pressArrow("up")); await t.settle()
    for (let i = 0; i < 7; i++) { act(() => t.keys.pressArrow("right")); await t.settle() }
    expect(slice()).toContain("todo  1")
    // 1st Space → include: only todo column remains on Default.
    act(() => t.keys.pressKey(" "))
    await until(t, () => t.frame().includes("1/6 task"))
    expect(slice()).not.toContain("ready  1")
    expect(slice()).toContain("todo  1")
    expect(slice()).toContain("synthesize")
    // 2nd Space → exclude: todo column gone; others back.
    act(() => t.keys.pressKey(" "))
    await until(t, () => t.frame().includes("5/6 task"))
    expect(slice()).not.toContain("todo  1")
    expect(slice()).toContain("ready  1")
    expect(slice()).not.toContain("synthesize")
    // atm10's mask is independent — its todo col is still there.
    expect(t.frame()).toContain("todo  0")
    // 3rd Space → off.
    act(() => t.keys.pressKey(" "))
    await until(t, () => !/\d\/6 task/.test(t.frame()))
    expect(slice()).toContain("todo  1")
    t.destroy()
  })

  test("detail pane follows selection while open", async () => {
    const t = await mountNode(<Kanban focused />, { width: 180, height: 48 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    // Start on triage (t0), Enter opens detail. → to 'todo' (t3) —
    // pane rehydrates without another Enter. Avoid empty 'scheduled'
    // column between todo and ready: transiting through a no-task
    // column closes the pane (intentional behavior).
    act(() => t.keys.pressEnter())
    await until(t, () => /Title\s+one-liner idea/.test(t.frame()))
    act(() => t.keys.pressArrow("right")); await t.settle()
    await until(t, () => /Assignee\s+analyst/.test(t.frame()))
    expect(t.frame()).toMatch(/Title\s+synthesize/)
    // ↑ leaves grid → pane closes.
    act(() => t.keys.pressArrow("up")); await t.settle()
    await until(t, () => !/Assignee\s+analyst/.test(t.frame()))
    t.destroy()
  })

  test("column overflow scrolls; selection follows ↑↓", async () => {
    mkdirSync(hermesPath("kanban/boards/tall"), { recursive: true })
    const db = new Database(hermesPath("kanban/boards/tall/kanban.db"), { create: true })
    schema(db)
    for (let i = 0; i < 30; i++)
      db.run("INSERT INTO tasks (id, title, status, priority, created_at) VALUES (?,?,?,?,?)",
        [`x${i}`, `item ${i}`, "triage", 0, now - i])
    db.close()
    resetKanban()
    const t = await mountNode(<Kanban focused />, { width: 180, height: 30 })
    try {
      await until(t, () => t.frame().includes("tall"))
      // Tab → atm10 head, Tab → tall head, ↓↓ into grid (status chips only).
      act(() => t.keys.pressTab()); await t.settle()
      act(() => t.keys.pressTab()); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      await until(t, () => t.frame().includes("item 0"))
      // maxH at h=30 is 14; item 29 doesn't fit.
      expect(t.frame()).not.toContain("item 29")
      for (let i = 0; i < 29; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
      await until(t, () => t.frame().includes("item 29"))
      expect(t.frame()).not.toContain("item 0")
    } finally {
      t.destroy()
      rmSync(hermesPath("kanban/boards/tall"), { recursive: true, force: true })
      resetKanban()
    }
  })
})

// ─── Direct-write path (bun:sqlite, matches dashboard PATCH) ─────────
describe("patchTask direct writes", () => {
  const read = (id: string): Record<string, unknown> | null => {
    const db = new Database(hermesPath("kanban.db"), { readonly: true })
    try {
      return db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | null
    } finally { db.close() }
  }
  const events = (id: string): Array<{ kind: string; payload: string | null }> => {
    const db = new Database(hermesPath("kanban.db"), { readonly: true })
    try {
      return db.query(
        "SELECT kind, payload FROM task_events WHERE task_id = ? ORDER BY id",
      ).all(id) as Array<{ kind: string; payload: string | null }>
    } finally { db.close() }
  }

  test("write handle applies hardened SQLite pragmas", async () => {
    const { kanbanWritePragmas } = await import("../src/service/hermes-kanban")
    const p = kanbanWritePragmas("default")!
    expect(String(p.journal_mode).toLowerCase()).toBe("wal")
    expect(p.synchronous).toBe(2) // FULL
    expect(p.wal_autocheckpoint).toBe(100)
    expect(p.busy_timeout).toBe(120_000)
    expect(p.secure_delete).toBe(1)
    expect(p.cell_size_check).toBe(1)
    expect(p.foreign_keys).toBe(1)
  })

  test("write handle honors valid busy_timeout override and ignores invalid values", async () => {
    const prev = process.env.HERMES_KANBAN_BUSY_TIMEOUT_MS
    const { kanbanWritePragmas, resetKanban } = await import("../src/service/hermes-kanban")
    try {
      process.env.HERMES_KANBAN_BUSY_TIMEOUT_MS = "2500"
      resetKanban()
      expect(kanbanWritePragmas("default")?.busy_timeout).toBe(2500)

      process.env.HERMES_KANBAN_BUSY_TIMEOUT_MS = "nope"
      resetKanban()
      expect(kanbanWritePragmas("default")?.busy_timeout).toBe(120_000)

      process.env.HERMES_KANBAN_BUSY_TIMEOUT_MS = "0"
      resetKanban()
      expect(kanbanWritePragmas("default")?.busy_timeout).toBe(120_000)
    } finally {
      if (prev === undefined) delete process.env.HERMES_KANBAN_BUSY_TIMEOUT_MS
      else process.env.HERMES_KANBAN_BUSY_TIMEOUT_MS = prev
      resetKanban()
    }
  })

  test("title + body in one txn ⇒ single 'edited' event", async () => {
    const { patchTask } = await import("../src/service/hermes-kanban")
    // Seed by re-using t4 (done) so we have a stable target.
    expect(patchTask("default", "t4", {
      title: "draft memo v2", body: "revised body",
    })).toBe(true)
    const row = read("t4")!
    expect(row.title).toBe("draft memo v2")
    expect(row.body).toBe("revised body")
    const es = events("t4").filter(e => e.kind === "edited")
    expect(es.length).toBeGreaterThanOrEqual(1)
    expect(es[es.length - 1].payload).toBeNull()
  })

  test("priority ⇒ 'reprioritized' event with JSON payload", async () => {
    const { patchTask } = await import("../src/service/hermes-kanban")
    expect(patchTask("default", "t4", { priority: 7 })).toBe(true)
    expect(read("t4")!.priority).toBe(7)
    const es = events("t4").filter(e => e.kind === "reprioritized")
    expect(es.length).toBeGreaterThanOrEqual(1)
    expect(JSON.parse(es[es.length - 1].payload!)).toEqual({ priority: 7 })
    // Clamp: negative collapses to 0, 10+ collapses to 9.
    expect(patchTask("default", "t4", { priority: 42 })).toBe(true)
    expect(read("t4")!.priority).toBe(9)
    expect(patchTask("default", "t4", { priority: -3 })).toBe(true)
    expect(read("t4")!.priority).toBe(0)
  })

  test("kanban worker facade mirrors the service write contract", async () => {
    const { patch } = await import("../src/io/kanban")
    expect(await patch("default", "t4", { priority: 6 })).toBe(true)
    expect(read("t4")!.priority).toBe(6)
    expect(await patch("default", "missing-task", { priority: 6 })).toBe(false)
  })

  test("real kanban worker patches the sandbox board", async () => {
    const prev = process.env.HERM_IO_INLINE
    process.env.HERM_IO_INLINE = ""
    // @ts-expect-error Bun query-string specifier creates a fresh module instance.
    const fresh = await import("../src/io/kanban?worker") as typeof import("../src/io/kanban")
    try {
      expect(await fresh.patch("default", "t4", { priority: 8 })).toBe(true)
      expect(read("t4")!.priority).toBe(8)
    } finally {
      fresh.close()
      if (prev === undefined) delete process.env.HERM_IO_INLINE
      else process.env.HERM_IO_INLINE = prev
    }
  })

  test("write handle reopens when a board database is replaced", () => {
    const root = hermesPath("kanban-replace")
    const path = join(root, "kanban.db")
    const old = `${path}.old`
    mkdirSync(root, { recursive: true })
    const seed = (priority: number) => {
      const db = new Database(path, { create: true })
      schema(db)
      db.query("INSERT INTO tasks (id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("replace-me", "Replace me", "ready", priority, now)
      db.close()
    }
    try {
      seed(0)
      expect(patchAt(root, "default", "replace-me", { priority: 1 })).toBe(true)
      renameSync(path, old)
      seed(0)

      expect(patchAt(root, "default", "replace-me", { priority: 7 })).toBe(true)
      const db = new Database(path)
      expect((db.query("SELECT priority FROM tasks WHERE id = ?").get("replace-me") as { priority: number }).priority).toBe(7)
      db.close()
    } finally {
      resetWrites()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("empty title rejected, unknown id returns false", async () => {
    const { patchTask } = await import("../src/service/hermes-kanban")
    expect(() => patchTask("default", "t4", { title: "   " })).toThrow(/empty/)
    expect(patchTask("default", "does-not-exist", { title: "x" })).toBe(false)
  })

  test("combined patch rolls back priority when title validation fails", () => {
    const before = read("t4")!.priority
    const count = events("t4").length
    expect(() => patchAt(process.env.HERMES_HOME!, "default", "t4", { priority: 8, title: "   " }))
      .toThrow(/empty/)
    expect(read("t4")!.priority).toBe(before)
    expect(events("t4")).toHaveLength(count)
  })

  const retries = () => {
    const prev = process.env.HERMES_KANBAN_BUSY_TIMEOUT_MS
    process.env.HERMES_KANBAN_BUSY_TIMEOUT_MS = "1"
    return () => {
      if (prev === undefined) delete process.env.HERMES_KANBAN_BUSY_TIMEOUT_MS
      else process.env.HERMES_KANBAN_BUSY_TIMEOUT_MS = prev
    }
  }

  test("default busy timeout does not stack application retries", async () => {
    const { internals } = await import("../src/service/hermes-kanban")
    const prev = process.env.HERMES_KANBAN_BUSY_TIMEOUT_MS
    delete process.env.HERMES_KANBAN_BUSY_TIMEOUT_MS
    const wait = spyOn(Atomics, "wait").mockImplementation((() => "timed-out") as never)
    const sqls: string[] = []
    const err = new Error("database is busy")
    const conn = {
      exec(sql: string) { sqls.push(sql); throw err },
      query() { return { get: () => null } },
    }
    try {
      expect(() => internals.writeTxn(conn as never, () => {})).toThrow(err)
      expect(sqls).toEqual(["BEGIN IMMEDIATE"])
      expect(wait).not.toHaveBeenCalled()
    } finally {
      wait.mockRestore()
      if (prev === undefined) delete process.env.HERMES_KANBAN_BUSY_TIMEOUT_MS
      else process.env.HERMES_KANBAN_BUSY_TIMEOUT_MS = prev
    }
  })

  test("BEGIN IMMEDIATE retries transient BUSY before running body", async () => {
    const { internals } = await import("../src/service/hermes-kanban")
    const restore = retries()
    const waits: number[] = []
    const wait = spyOn(Atomics, "wait").mockImplementation(((arr: Int32Array, idx: number, val: number, timeout?: number) => {
      void arr; void idx; void val
      waits.push(Number(timeout))
      return "timed-out"
    }) as never)
    let body = 0
    const sqls: string[] = []
    const conn = {
      exec(sql: string) {
        sqls.push(sql)
        if (sql === "BEGIN IMMEDIATE" && sqls.filter(s => s === sql).length === 1)
          throw new Error("database is locked")
      },
      query() { return { get: () => null } },
    }
    try {
      expect(internals.writeTxn(conn as never, () => { body++; return "ok" })).toBe("ok")
      expect(body).toBe(1)
      expect(sqls).toEqual(["BEGIN IMMEDIATE", "BEGIN IMMEDIATE", "COMMIT"])
      expect(waits.length).toBe(1)
      expect(waits[0]).toBeGreaterThanOrEqual(20)
      expect(waits[0]).toBeLessThanOrEqual(150)
    } finally { wait.mockRestore(); restore() }
  })

  test("COMMIT retries transient BUSY without replaying body", async () => {
    const { internals } = await import("../src/service/hermes-kanban")
    const restore = retries()
    const wait = spyOn(Atomics, "wait").mockImplementation((() => "timed-out") as never)
    let body = 0
    const sqls: string[] = []
    const conn = {
      exec(sql: string) {
        sqls.push(sql)
        if (sql === "COMMIT" && sqls.filter(s => s === sql).length === 1)
          throw new Error("database is busy")
      },
      query() { return { get: () => null } },
    }
    try {
      internals.writeTxn(conn as never, () => { body++ })
      expect(body).toBe(1)
      expect(sqls).toEqual(["BEGIN IMMEDIATE", "COMMIT", "COMMIT"])
    } finally { wait.mockRestore(); restore() }
  })

  test("persistent COMMIT BUSY rolls back and preserves original error", async () => {
    const { internals } = await import("../src/service/hermes-kanban")
    const restore = retries()
    const wait = spyOn(Atomics, "wait").mockImplementation((() => "timed-out") as never)
    let body = 0
    const sqls: string[] = []
    const err = new Error("database is busy")
    const conn = {
      exec(sql: string) {
        sqls.push(sql)
        if (sql === "COMMIT") throw err
      },
      query() { return { get: () => null } },
    }
    try {
      expect(() => internals.writeTxn(conn as never, () => { body++ })).toThrow(err)
      expect(body).toBe(1)
      expect(sqls).toEqual([
        "BEGIN IMMEDIATE",
        "COMMIT", "COMMIT", "COMMIT", "COMMIT", "COMMIT", "COMMIT",
        "ROLLBACK",
      ])
    } finally { wait.mockRestore(); restore() }
  })
})

// ─── Tab-into-pane nav + field editors ───────────────────────────────
describe("Kanban detail pane", () => {
  test("Tab with pane open enters pane; Tab inside pane walks fields", async () => {
    const t = await mountNode(<Kanban focused />, { width: 180, height: 48 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    // → → → to 'ready' (t1), Enter opens detail.
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => /Assignee\s+researcher/.test(t.frame()))
    // Hint while grid-tier + pane open: "Tab into pane".
    expect(t.frame()).toContain("Tab into pane")
    // Tab → pane tier. Title is the first field, gets the edit hint.
    act(() => t.keys.pressTab()); await t.settle()
    await until(t, () => t.frame().includes("Enter edit"))
    // First Esc → back to grid (pane stays open).
    act(() => t.keys.pressEscape()); await t.settle()
    await until(t, () => t.frame().includes("Tab into pane"))
    expect(t.frame()).toMatch(/Assignee\s+researcher/)  // pane still open
    // Second Esc → pane closes.
    act(() => t.keys.pressEscape()); await t.settle()
    await until(t, () => !/Assignee\s+researcher/.test(t.frame()))
    t.destroy()
  })

  test("priority row arrows navigate; Enter opens select and writes", async () => {
    const db = new Database(hermesPath("kanban.db"))
    db.run("UPDATE tasks SET priority = 3 WHERE id = 't1'")
    db.close()
    resetKanban()
    const prio = () => {
      const check = new Database(hermesPath("kanban.db"), { readonly: true })
      const row = check.query("SELECT priority FROM tasks WHERE id = 't1'")
        .get() as { priority: number }
      check.close()
      return row.priority
    }
    const t = await mountNode(<Kanban focused />, { width: 180, height: 48 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => /Assignee\s+researcher/.test(t.frame()))
    act(() => t.keys.pressTab()); await t.settle()
    act(() => t.keys.pressTab()); await t.settle()
    act(() => t.keys.pressTab()); await t.settle()
    act(() => t.keys.pressTab()); await t.settle()
    await until(t, () => t.frame().includes("Enter select"))
    act(() => t.keys.pressArrow("down")); await t.settle()
    expect(prio()).toBe(3)
    await until(t, () => t.frame().includes("Enter change"))
    act(() => t.keys.pressArrow("up")); await t.settle()
    await until(t, () => t.frame().includes("Enter select"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Priority for t1"))
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => prio() === 4)
    t.destroy()
  })
})

// ─── Persistence (filter masks + open boards) ────────────────────────
describe("Kanban preferences round-trip", () => {
  test("filter chip toggle persists across remount", async () => {
    const prefsMod = await import("../src/context/preferences")
    prefsMod.reset()
    // Start clean — no saved kanban prefs.
    prefsMod.set("kanban", undefined as never)

    const t1 = await mountNode(<Kanban focused />, { width: 180, height: 44 })
    await until(t1, () => t1.frame().includes("Kanban · 3 boards"))
    // Flip 'analyst' chip to include via the filter tier.
    act(() => t1.keys.pressArrow("up")); await t1.settle()
    act(() => t1.keys.pressKey(" "))
    await until(t1, () => t1.frame().includes("1/6 task"))
    t1.destroy()

    // Saved?
    prefsMod.reset()
    const saved = prefsMod.load().kanban
    expect(saved?.masks?.default?.who).toEqual([["analyst", "in"]])

    // Remount — mask rehydrates without user input.
    const t2 = await mountNode(<Kanban focused />, { width: 180, height: 44 })
    await until(t2, () => t2.frame().includes("1/6 task"))
    expect(t2.frame()).toContain("synthesize")
    expect(t2.frame()).not.toContain("research cost")
    // Cleanup for the rest of the suite.
    t2.destroy()
    prefsMod.set("kanban", undefined as never)
  })
})

// ── max_retries parity (upstream ac51c4c1a) ──────────────────────────
// New nullable `tasks.max_retries INTEGER` column. Herm surfaces it in
// the detail pane as "Retries N" only when non-null, same shape as
// Workspace/Skills. The label is shortened to fit the detail pane's
// 10-col label track (upstream CLI uses "max-retries", 11 chars, which
// overflows). Schema-tolerance (selectCol → NULL AS max_retries) is
// covered implicitly by every other test in this file: their beforeAll
// schema has no such column, and they all still pass.
describe("max_retries parity", () => {
  beforeAll(() => {
    mkdirSync(hermesPath("kanban/boards/mxr"), { recursive: true })
    const db = new Database(hermesPath("kanban/boards/mxr/kanban.db"), { create: true })
    schema(db)
    db.run("ALTER TABLE tasks ADD COLUMN max_retries INTEGER")
    const ins = db.prepare(
      `INSERT INTO tasks (id, title, status, priority, created_at, max_retries)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    ins.run("mxr1", "retries explicit", "ready", 3, now, 5)
    ins.run("mxr2", "retries default", "ready", 2, now - 1, null)
    db.close()
    resetKanban()
  })

  test("boardOf() surfaces max_retries on tasks that set it; null otherwise", () => {
    const rows = boardOf("mxr").get("ready") ?? []
    const byId = new Map(rows.map(r => [r.id, r]))
    expect(byId.get("mxr1")?.max_retries).toBe(5)
    expect(byId.get("mxr2")?.max_retries).toBeNull()
  })

  test("detail pane renders 'Max retries 5' when non-null, omits row otherwise", async () => {
    const t = await mountNode(<Kanban focused />, { width: 180, height: 48 })
    try {
      await until(t, () => /mxr/.test(t.frame()))
      // Tab walks heads (default → atm10 → mxr); ↓↓ head → filter → grid;
      // →→→ triage → todo → scheduled → ready. Row 0 is mxr1 (priority 3).
      act(() => t.keys.pressTab()); await t.settle()
      act(() => t.keys.pressTab()); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressEnter())
      await until(t, () => /Title\s+retries explicit/.test(t.frame()))
      expect(t.frame()).toMatch(/Retries\s+5/)
      // ↓ to mxr2 — pane rehydrates, row drops.
      act(() => t.keys.pressArrow("down")); await t.settle()
      await until(t, () => /Title\s+retries default/.test(t.frame()))
      expect(t.frame()).not.toMatch(/Retries\s+\d/)
    } finally {
      t.destroy()
    }
  })
})

describe("diagnostics parser", () => {
  test("parseDiagnostics() accepts CLI shape and filters malformed rows", () => {
    const out = parseDiagnostics(JSON.stringify([
      {
        task_id: "t1", title: "a", status: "running", assignee: "worker",
        diagnostics: [
          {
            kind: "spawn_loop", severity: "critical", title: "10 failures",
            detail: "spawn failed 10x", actions: [
              { kind: "reassign", label: "Reassign elsewhere", payload: {}, suggested: true },
              { kind: "cli_hint", label: "hermes profile doctor", payload: {} },
            ],
            first_seen_at: 100, last_seen_at: 200, count: 10, run_id: 7,
            data: { count: 10 },
          },
          // Bad severity → dropped.
          { kind: "bad", severity: "info", title: "x", detail: "", actions: [] },
        ],
      },
      // Missing task_id → row dropped.
      { title: "orphan", diagnostics: [] },
    ]))
    expect(out).toHaveLength(1)
    expect(out[0].task_id).toBe("t1")
    expect(out[0].diagnostics).toHaveLength(1)
    const d = out[0].diagnostics[0]
    expect(d.severity).toBe("critical")
    expect(d.count).toBe(10)
    expect(d.actions).toHaveLength(2)
    expect(d.actions[0].suggested).toBe(true)
    expect(d.actions[1].suggested).toBe(false)
  })

  test("parseDiagnostics() returns [] on empty/invalid/bad-JSON input", () => {
    expect(parseDiagnostics("")).toEqual([])
    expect(parseDiagnostics("[]")).toEqual([])
    expect(parseDiagnostics("not json")).toEqual([])
    expect(parseDiagnostics("{}")).toEqual([])
  })

  test("maxSeverity() picks worst; sortDiags() orders critical→warning", () => {
    const ds = [
      { kind: "a", severity: "warning" as const, title: "", detail: "", actions: [], first_seen_at: 0, last_seen_at: 0, count: 1, run_id: null, data: {} },
      { kind: "b", severity: "critical" as const, title: "", detail: "", actions: [], first_seen_at: 0, last_seen_at: 0, count: 1, run_id: null, data: {} },
      { kind: "c", severity: "error" as const, title: "", detail: "", actions: [], first_seen_at: 0, last_seen_at: 0, count: 1, run_id: null, data: {} },
    ]
    expect(maxSeverity(ds)).toBe("critical")
    expect(maxSeverity([])).toBeNull()
    expect(sortDiags(ds).map(d => d.kind)).toEqual(["b", "c", "a"])
  })
})

describe("Kanban diagnostics UI", () => {
  // Emit a diagnostics payload keyed by board slug. Every `shell.exec`
  // that contains the `diagnostics` verb matches the slug in `--board
  // <slug>` against the fixture and returns that board's rows.
  const diagFixture = (cmd: string, byBoard: Record<string, unknown[]>): string => {
    const m = /--board\s+(\S+)\s+diagnostics/.exec(cmd)
    const slug = m?.[1] ?? "default"
    return JSON.stringify(byBoard[slug] ?? [])
  }

  test("diagnostics refreshes serialize and collapse to the latest request", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const gw = new MockGateway({
      "shell.exec": async p => {
        if (/\bdiagnostics\b/.test(p.command as string)) await gate
        return { stdout: "[]", stderr: "", code: 0 }
      },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    const count = listBoards().length
    const calls = () => gw.calls.filter(c => c.method === "shell.exec" && /\bdiagnostics\b/.test(String(c.params.command))).length
    await until(t, () => calls() === count)

    await act(async () => { await t.keys.typeText("rr") })
    await t.settle()
    expect(calls()).toBe(count)

    release()
    await until(t, () => calls() === count * 2)
    expect(calls()).toBe(count * 2)
    t.destroy()
  })

  test("Card prefixes severity glyph; SidePane renders Diagnostics block + suggested action", async () => {
    const fixture = {
      default: [{
        task_id: "t5", title: "need decision", status: "blocked", assignee: "researcher",
        diagnostics: [{
          kind: "stuck_blocked", severity: "error",
          title: "Blocked for 7 days",
          detail: "Awaiting operator input on rate-limit keying.",
          actions: [
            { kind: "comment", label: "Add an unblock comment", payload: {}, suggested: true },
            { kind: "unblock", label: "Mark ready", payload: {} },
          ],
          first_seen_at: now - 86400 * 7, last_seen_at: now, count: 1, run_id: null, data: {},
        }],
      }],
    }
    const gw = new MockGateway({
      "shell.exec": p => /\bdiagnostics\b/.test(p.command as string)
        ? ({ stdout: diagFixture(p.command as string, fixture), stderr: "", code: 0 })
        : ({ stdout: "", stderr: "", code: 0 }),
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 48 })
    try {
      // Card badge: the `!!` glyph sits on the same line as "need decision"
      // in the blocked column.
      await until(t, () => {
        const row = t.frame().split("\n").find(l => l.includes("need decision"))
        return !!row && /!!/.test(row)
      })

      // Tab → grid; arrow over to the blocked column (index 5: triage, todo,
      // scheduled, ready, running, blocked). Row 0 is t5 by priority sort.
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressEnter())
      await until(t, () => /Diagnostics\s+\(1\)/.test(t.frame()))
      const f = t.frame()
      expect(f).toMatch(/\[error\]\s+stuck_blocked/)
      expect(f).toContain("Blocked for 7 days")
      expect(f).toContain("Awaiting operator input")
      // Suggested action leads with → arrow, non-suggested with ·.
      expect(f).toMatch(/→\s+Add an unblock comment/)
      expect(f).toMatch(/·\s+Mark ready/)
    } finally {
      t.destroy()
    }
  })

  test("task without diagnostics shows no badge; other tasks still get theirs", async () => {
    const fixture = {
      default: [{
        task_id: "t2", title: "", status: "running", assignee: "researcher",
        diagnostics: [{
          kind: "crash_loop", severity: "critical", title: "3 crashes",
          detail: "", actions: [],
          first_seen_at: now, last_seen_at: now, count: 3, run_id: 7, data: {},
        }],
      }],
    }
    const gw = new MockGateway({
      "shell.exec": p => /\bdiagnostics\b/.test(p.command as string)
        ? ({ stdout: diagFixture(p.command as string, fixture), stderr: "", code: 0 })
        : ({ stdout: "", stderr: "", code: 0 }),
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 48 })
    try {
      // Badge must attach to its own task — `‼` appears adjacent to
      // "research perf" in the per-column cell, never to "research
      // cost" in an adjacent column. Use cell-scoped regexes (no "."
      // in between) so "same row, different column" doesn't alias.
      await until(t, () => /‼\s*research perf/.test(t.frame()))
      expect(t.frame()).not.toMatch(/[‼⚠]\s*research cost/)
      expect(t.frame()).not.toMatch(/!!\s*research cost/)
    } finally {
      t.destroy()
    }
  })

  test("diagnostics CLI failure → board still renders, no badges", async () => {
    const gw = new MockGateway({
      "shell.exec": p => /\bdiagnostics\b/.test(p.command as string)
        ? ({ stdout: "", stderr: "hermes: command not found", code: 127 })
        : ({ stdout: "", stderr: "", code: 0 }),
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    try {
      // Don't depend on board count — other describes may seed extra
      // boards by the time this one runs. Gate on a task title instead.
      await until(t, () => t.frame().includes("research cost"))
      // No badge glyphs leaked into any row.
      expect(t.frame()).not.toMatch(/[‼⚠]|!!/)
    } finally {
      t.destroy()
    }
  })
})

// ── upstream parity: scheduled status + new task columns ─────────────
// Upstream e3823657d (scheduled), 31fe22903 (session_id), 79f6654d1 /
// f01ee0b57 (model_override), 1733cb3a1 (branch_name), e286e6875
// (stale → last_heartbeat_at). All additive nullable columns; herm's
// selectCol() tolerates absence so prior-version DBs still load.
describe("scheduled status + new fields parity", () => {
  beforeAll(() => {
    mkdirSync(hermesPath("kanban/boards/sched"), { recursive: true })
    const db = new Database(hermesPath("kanban/boards/sched/kanban.db"), { create: true })
    schema(db)
    db.run("ALTER TABLE tasks ADD COLUMN branch_name TEXT")
    db.run("ALTER TABLE tasks ADD COLUMN project_id TEXT")
    db.run("ALTER TABLE tasks ADD COLUMN model_override TEXT")
    db.run("ALTER TABLE tasks ADD COLUMN session_id TEXT")
    db.run("ALTER TABLE tasks ADD COLUMN last_heartbeat_at INTEGER")
    const ins = db.prepare(
      `INSERT INTO tasks (id, title, status, priority, created_at,
         started_at, workspace_kind, workspace_path, branch_name,
         project_id, model_override, session_id, last_heartbeat_at, worker_pid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    // sch1: parked in scheduled, full set of new fields.
    ins.run("sch1", "delayed follow-up", "scheduled", 4, now - 300,
      null, "worktree", "/tmp/wt/sch1", "feat/delayed",
      "herm", "anthropic/claude-sonnet-4", "sess-abc123", null, null)
    // sch2: running with model + heartbeat.
    ins.run("sch2", "model-pinned worker", "running", 3, now - 60,
      now - 60, null, null, null,
      null, "openrouter/qwen3-coder", null, now - 45, 9999)
    // sch3: plain ready task, exercises null-column fallback.
    ins.run("sch3", "vanilla", "ready", 1, now - 30,
      null, null, null, null, null, null, null, null, null)
    db.close()
    resetKanban()
  })

  test("STATUSES includes 'scheduled' between todo and ready", async () => {
    const { STATUSES } = await import("../src/service/hermes-kanban")
    expect(STATUSES).toEqual(["triage", "todo", "scheduled", "ready", "running", "blocked", "done"])
  })

  test("boardOf() loads scheduled tasks into their column with new fields populated", () => {
    const b = boardOf("sched")
    const row = b.get("scheduled")?.[0]
    expect(row?.id).toBe("sch1")
    expect(row?.branch_name).toBe("feat/delayed")
    expect(row?.project_id).toBe("herm")
    expect(row?.model_override).toBe("anthropic/claude-sonnet-4")
    expect(row?.session_id).toBe("sess-abc123")
    expect(row?.workspace_kind).toBe("worktree")
    // last_heartbeat_at null on scheduled (never ran).
    expect(row?.last_heartbeat_at).toBeNull()

    const run = b.get("running")?.[0]
    expect(run?.id).toBe("sch2")
    expect(run?.model_override).toBe("openrouter/qwen3-coder")
    expect(run?.last_heartbeat_at).toBe(now - 45)

    // Schema-tolerance: vanilla task has all new fields null.
    const ready = b.get("ready")?.find(t => t.id === "sch3")
    expect(ready?.branch_name).toBeNull()
    expect(ready?.project_id).toBeNull()
    expect(ready?.model_override).toBeNull()
    expect(ready?.session_id).toBeNull()
    expect(ready?.last_heartbeat_at).toBeNull()
  })

  test("detail pane renders Project / Branch / Model / Session for scheduled task", async () => {
    const t = await mountNode(<Kanban focused />, { width: 200, height: 60 })
    try {
      await until(t, () => /▾\s+sched/.test(t.frame()))
      // Tab through heads (default → atm10 → mxr → sched). Then ↓↓
      // head → filter → grid. Tab/goBoard resets col=0, so →→ to
      // scheduled (col 2: triage, todo, scheduled).
      act(() => t.keys.pressTab()); await t.settle()
      act(() => t.keys.pressTab()); await t.settle()
      act(() => t.keys.pressTab()); await t.settle()
      await until(t, () => /▾\s+sched/.test(t.frame()))
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressEnter())
      await until(t, () => /Title\s+delayed follow-up/.test(t.frame()))
      const f = t.frame()
      expect(f).toMatch(/Project\s+herm/)
      expect(f).toMatch(/Branch\s+feat\/delayed/)
      expect(f).toMatch(/Model\s+anthropic\/claude-sonnet-4/)
      expect(f).toMatch(/Session\s+sess-abc123/)
    } finally {
      t.destroy()
    }
  })

  test("typed dependency and recurrence state render on cards and detail pane", async () => {
    const db = new Database(hermesPath("kanban/boards/sched/kanban.db"))
    db.run("UPDATE tasks SET block_kind = 'dependency', block_recurrences = 1 WHERE id = 'sch1'")
    db.run("UPDATE tasks SET block_kind = 'capability', block_recurrences = 3 WHERE id = 'sch3'")
    db.close()
    resetKanban()

    const t = await mountNode(<Kanban focused />, { width: 210, height: 60 })
    try {
      await until(t, () => /\[dep\]\s+delayed follow-up/.test(t.frame()))
      expect(t.frame()).toMatch(/\[cap×3\]\s+vanilla/)
      act(() => t.keys.pressTab()); await t.settle()
      act(() => t.keys.pressTab()); await t.settle()
      act(() => t.keys.pressTab()); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressArrow("down")); await t.settle()
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressArrow("right")); await t.settle()
      act(() => t.keys.pressEnter())
      await until(t, () => /Status\s+scheduled · dependency-wait/.test(t.frame()))
    } finally {
      t.destroy()
    }
  })

  test("detail pane shows Heartbeat row only for running tasks with a heartbeat", async () => {
    const { detailOf } = await import("../src/service/hermes-kanban")
    expect(detailOf("sched", "sch2")?.last_heartbeat_at).toBe(now - 45)
    expect(detailOf("sched", "sch1")?.last_heartbeat_at).toBeNull()
    expect(detailOf("sched", "sch3")?.last_heartbeat_at).toBeNull()
  })
})
