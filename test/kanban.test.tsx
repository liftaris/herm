import { describe, test, expect, beforeAll } from "bun:test"
import { act } from "react"
import { Database } from "bun:sqlite"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { mountNode, MockGateway, until } from "./harness"
import { hermesPath } from "../src/utils/hermes-home"
import {
  board, boardOf, detail, assignees, tailLog, q, resetKanban,
  currentBoard, listBoards,
} from "../src/utils/hermes-kanban"
import { Kanban } from "../src/tabs/Kanban"

const now = Math.floor(Date.now() / 1000)

const schema = (db: Database) => {
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, title TEXT, body TEXT, assignee TEXT,
    status TEXT, priority INTEGER DEFAULT 0, tenant TEXT,
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
}

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
  db.run("INSERT INTO task_links (parent_id, child_id) VALUES ('t1','t3'),('t2','t3')")
  db.run("INSERT INTO task_comments (task_id, author, body, created_at) VALUES (?,?,?,?)",
    ["t1", "kaio", "check AWS reserved pricing too", now - 1000])
  db.run("INSERT INTO task_comments (task_id, author, body, created_at) VALUES (?,?,?,?)",
    ["t5", "worker", "review-required: implementation ready for eyes", now - 700])
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
    expect(b.get("triage")).toEqual([])
    expect(b.get("blocked")?.[0]?.review_required).toBe(true)
  })

  test("boardOf() reads per-slug without touching current", () => {
    expect(currentBoard()).toBe("default")
    expect(boardOf("atm10").get("ready")?.[0]?.id).toBe("m1")
    expect(boardOf("default").get("ready")?.[0]?.id).toBe("t1")
    expect([...boardOf("zeta").values()].every(v => v.length === 0)).toBe(true)
  })

  test("detail() hydrates parents/children/comments", () => {
    const d = detail("t3")!
    expect(d.parents.sort()).toEqual(["t1", "t2"])
    expect(d.children).toEqual([])
    const d1 = detail("t1")!
    expect(d1.children).toEqual(["t3"])
    expect(d1.comments[0].body).toContain("AWS reserved")
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
  test("stacks boards, empty last, chips + one-line rows", async () => {
    const t = await mountNode(<Kanban focused />, { width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards · 6 tasks"))
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
    expect(chipLine).toMatch(/triage\s+todo\s+ready\s+running\s+blocked\s+done/)
    // atm10 has no assignees — its chip row is priority + status only.
    expect(f).not.toMatch(/ATM10 Server[\s\S]*?\n.*researcher.*\n/)
    // One-line cards: title renders, meta line does not.
    expect(f).toContain("research cost")
    expect(f).toContain("upgrade forge")
    expect(f).toContain("1 review")
    expect(f).toContain("⚑ need decision")
    expect(f).not.toMatch(/t2\s+researcher\s+P3/)
    t.destroy()
  })

  test("arrows nav within board; Enter → detail pane", async () => {
    const t = await mountNode(<Kanban focused />, { width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    // Initial tier = grid on current board. → → to 'ready' (col 2 at full width).
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => /Assignee\s+researcher/.test(t.frame()))
    expect(t.frame()).toMatch(/Children\s+t3/)
    expect(t.frame()).toContain("AWS reserved")
    expect(t.frame()).toMatch(/a assign\s+c comment\s+u unblock/)
    act(() => t.keys.pressEscape())
    await until(t, () => !/Assignee\s+researcher/.test(t.frame()))
    t.destroy()
  })

  test("Tab walks boards; verbs pin --board to active section", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { cmds.push(p.command as string); return { stdout: "", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("▾ Default"))
    expect(t.frame()).toContain("Tab board")
    // Tab → atm10; hint switches to head-tier wording.
    act(() => t.keys.pressTab()); await t.settle()
    await until(t, () => t.frame().includes("Space fold"))
    // ↓↓ descends filter → grid; →→ to 'ready' on atm10.
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressArrow("down")); await t.settle()
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
    await until(t, () => t.frame().includes("1/5 task"))
    // include: only analyst's task survives the who group.
    expect(t.frame()).toContain("synthesize")
    expect(t.frame()).not.toContain("research cost")
    act(() => t.keys.pressKey(" "))
    await until(t, () => t.frame().includes("4/5 task"))
    // exclude: everyone except analyst.
    expect(t.frame()).not.toContain("synthesize")
    expect(t.frame()).toContain("research cost")
    act(() => t.keys.pressKey(" "))
    await until(t, () => !/\d\/5 task/.test(t.frame()))
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
      "shell.exec": p => { cmds.push(p.command as string); return { stdout: "", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
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
      "shell.exec": p => { cmds.push(p.command as string); return { stdout: "", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    for (let i = 0; i < 4; i++) { act(() => t.keys.pressArrow("right")); await t.settle() }
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

  test("d → confirm → archive", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { cmds.push(p.command as string); return { stdout: "", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    for (let i = 0; i < 5; i++) { act(() => t.keys.pressArrow("right")); await t.settle() }
    await act(async () => { await t.keys.typeText("d") })
    await until(t, () => t.frame().includes("Archive task?"))
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => cmds.length === 1)
    expect(cmds[0]).toBe("hermes kanban --board default archive t4")
    t.destroy()
  })

  test("n → create dialog → shell.exec create on active board", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { cmds.push(p.command as string); return { stdout: "t6", stderr: "", code: 0 } },
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
      "shell.exec": p => { cmds.push(p.command as string); return { stdout: "x", stderr: "", code: 0 } },
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
      "shell.exec": p => { cmds.push(p.command as string); return { stdout: "t7", stderr: "", code: 0 } },
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
      "shell.exec": p => { cmds.push(p.command as string); return { stdout: "t8", stderr: "", code: 0 } },
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
      "shell.exec": p => { cmds.push(p.command as string); return { stdout: "t9", stderr: "", code: 0 } },
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
      "shell.exec": p => { cmds.push(p.command as string); return { stdout: "tb", stderr: "", code: 0 } },
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
      "shell.exec": p => { cmds.push(p.command as string); return { stdout: "t10", stderr: "", code: 0 } },
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
    // more→tenant→workspace
    act(() => t.keys.pressArrow("down")); await t.settle() // tenant
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

  test("create form: Esc cancels — no command", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { cmds.push(p.command as string); return { stdout: "x", stderr: "", code: 0 } },
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
      "shell.exec": p => { cmds.push(p.command as string); return { stdout: "tp", stderr: "", code: 0 } },
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

  test("D → confirm → dispatch", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { cmds.push(p.command as string); return { stdout: "[]", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Kanban focused />, { gw, width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    await act(async () => { await t.keys.typeText("D") })
    await until(t, () => t.frame().includes("Dispatch · default"))
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => cmds.length === 1)
    expect(cmds[0]).toBe("hermes kanban --board default dispatch --json")
    t.destroy()
  })

  test("l opens log pane; Esc closes", async () => {
    const t = await mountNode(<Kanban focused />, { width: 180, height: 44 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    for (let i = 0; i < 3; i++) { act(() => t.keys.pressArrow("right")); await t.settle() }
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
    await act(async () => { await t.keys.typeText("a") })
    await until(t, () => t.frame().includes("Assign t1"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("cycle detected"))
    t.destroy()
  })

  test("↓ walks off the last row into the next board's head", async () => {
    const t = await mountNode(<Kanban focused />, { width: 180, height: 48 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    // Grid on default, col 0 (triage, 0 tasks). Single ↓ from an empty
    // column's row 0 goes nowhere; nav to todo (1 task) first.
    act(() => t.keys.pressArrow("right")); await t.settle()
    // row 0 → ↓ crosses into atm10 head.
    act(() => t.keys.pressArrow("down")); await t.settle()
    await until(t, () => t.frame().includes("Space fold"))
    // ↓↓ → filter → grid on atm10; → → to ready.
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressArrow("down")); await t.settle()
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
    // →→ to 'ready' on Default; open detail on t1.
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
    await until(t, () => t.frame().includes("1/5 task"))
    expect(slice()).not.toContain("ready  1")
    expect(slice()).toContain("todo  1")
    expect(slice()).toContain("synthesize")
    // 2nd Space → exclude: todo column gone; others back.
    act(() => t.keys.pressKey(" "))
    await until(t, () => t.frame().includes("4/5 task"))
    expect(slice()).not.toContain("todo  1")
    expect(slice()).toContain("ready  1")
    expect(slice()).not.toContain("synthesize")
    // atm10's mask is independent — its todo col is still there.
    expect(t.frame()).toContain("todo  0")
    // 3rd Space → off.
    act(() => t.keys.pressKey(" "))
    await until(t, () => !/\d\/5 task/.test(t.frame()))
    expect(slice()).toContain("todo  1")
    t.destroy()
  })

  test("detail pane follows selection while open", async () => {
    const t = await mountNode(<Kanban focused />, { width: 180, height: 48 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    // → to 'todo' (t3), Enter opens detail.
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => /Assignee\s+analyst/.test(t.frame()))
    // → to 'ready' (t1) — pane rehydrates without another Enter.
    act(() => t.keys.pressArrow("right")); await t.settle()
    await until(t, () => /Assignee\s+researcher/.test(t.frame()))
    expect(t.frame()).toMatch(/Children\s+t3/)
    // ↑ leaves grid → pane closes.
    act(() => t.keys.pressArrow("up")); await t.settle()
    await until(t, () => !/Assignee\s+researcher/.test(t.frame()))
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

  test("title + body in one txn ⇒ single 'edited' event", async () => {
    const { patchTask } = await import("../src/utils/hermes-kanban")
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
    const { patchTask } = await import("../src/utils/hermes-kanban")
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

  test("empty title rejected, unknown id returns false", async () => {
    const { patchTask } = await import("../src/utils/hermes-kanban")
    expect(() => patchTask("default", "t4", { title: "   " })).toThrow(/empty/)
    expect(patchTask("default", "does-not-exist", { title: "x" })).toBe(false)
  })
})

// ─── Tab-into-pane nav + field editors ───────────────────────────────
describe("Kanban detail pane", () => {
  test("Tab with pane open enters pane; Tab inside pane walks fields", async () => {
    const t = await mountNode(<Kanban focused />, { width: 180, height: 48 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    // → → to 'ready' (t1), Enter opens detail.
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

  test("Enter on priority row in pane → DialogSelect → direct write", async () => {
    // Re-seed t1's priority so we have a known starting value.
    const db = new Database(hermesPath("kanban.db"))
    db.run("UPDATE tasks SET priority = 3 WHERE id = 't1'")
    db.close()
    resetKanban()
    const t = await mountNode(<Kanban focused />, { width: 180, height: 48 })
    await until(t, () => t.frame().includes("Kanban · 3 boards"))
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressArrow("right")); await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => /Assignee\s+researcher/.test(t.frame()))
    // Tab in, then Tab twice more (title → body → assignee → priority).
    act(() => t.keys.pressTab()); await t.settle()
    act(() => t.keys.pressTab()); await t.settle()
    act(() => t.keys.pressTab()); await t.settle()
    act(() => t.keys.pressTab()); await t.settle()
    // Priority row shows its hint when focused.
    await until(t, () => t.frame().includes("↑↓ / Enter"))
    // ↑ bumps priority directly (patchTask path, no dialog).
    act(() => t.keys.pressArrow("up")); await t.settle()
    // Read back via a fresh RO handle — herm's internal cache is RW/RO
    // split and the write went through the RW handle.
    const check = new Database(hermesPath("kanban.db"), { readonly: true })
    const row = check.query("SELECT priority FROM tasks WHERE id = 't1'")
      .get() as { priority: number }
    check.close()
    expect(row.priority).toBe(4)
    t.destroy()
  })
})

// ─── Persistence (filter masks + open boards) ────────────────────────
describe("Kanban preferences round-trip", () => {
  test("filter chip toggle persists across remount", async () => {
    const prefsMod = await import("../src/utils/preferences")
    prefsMod.reset()
    // Start clean — no saved kanban prefs.
    prefsMod.set("kanban", undefined as never)

    const t1 = await mountNode(<Kanban focused />, { width: 180, height: 44 })
    await until(t1, () => t1.frame().includes("Kanban · 3 boards"))
    // Flip 'analyst' chip to include via the filter tier.
    act(() => t1.keys.pressArrow("up")); await t1.settle()
    act(() => t1.keys.pressKey(" "))
    await until(t1, () => t1.frame().includes("1/5 task"))
    t1.destroy()

    // Saved?
    prefsMod.reset()
    const saved = prefsMod.load().kanban
    expect(saved?.masks?.default?.who).toEqual([["analyst", "in"]])

    // Remount — mask rehydrates without user input.
    const t2 = await mountNode(<Kanban focused />, { width: 180, height: 44 })
    await until(t2, () => t2.frame().includes("1/5 task"))
    expect(t2.frame()).toContain("synthesize")
    expect(t2.frame()).not.toContain("research cost")
    // Cleanup for the rest of the suite.
    t2.destroy()
    prefsMod.set("kanban", undefined as never)
  })
})
