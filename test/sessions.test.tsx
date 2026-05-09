import { describe, test, expect } from "bun:test"
import { act } from "react"
import { mountNode, until, MockGateway } from "./harness"
import { Sessions, fold } from "../src/tabs/Sessions"
import type { SessionHit } from "../src/utils/hermes-home"
import type { PeekMsg } from "../src/utils/sessions-db"

const ROWS = [
  { id: "sid-a", title: "First session", preview: "hey", message_count: 4, started_at: 1700000000, source: "tui" },
  { id: "sid-b", title: "Second session", preview: "", message_count: 12, started_at: 1699999000, source: "cli" },
]

const NOIO = { list: () => [], search: () => [], remove: () => true, rename: () => true, subagents: () => [], peek: () => [] }

describe("Sessions tab", () => {
  test("lists from session.list RPC and switches on Enter", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: ROWS }) })
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={NOIO} onSwitch={sid => { switched = sid }} />,
      { gw },
    )
    await until(t, () => t.frame().includes("Sessions (2)"))

    const f = t.frame()
    expect(f).toContain("First session")
    expect(f).toContain("Second session")
    expect(f).toContain("TUI")
    expect(f).toContain("CLI")
    expect(t.gw.last("session.list")).toBeDefined()

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Load session?"))
    expect(t.frame()).toContain("First session")
    expect(t.frame()).toContain("4 msgs")
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(switched).toBe("sid-a")

    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Load session?"))
    await act(async () => { await t.keys.typeText("n") })
    await t.settle()
    expect(switched).toBe("sid-a") // cancelled

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Load session?"))
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(switched).toBe("sid-b")
    t.destroy()
  })

  test("activating current session skips confirm", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: ROWS }) })
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={NOIO} currentId="sid-a" onSwitch={sid => { switched = sid }} />,
      { gw },
    )
    await until(t, () => t.frame().includes("Sessions (2)"))
    act(() => t.keys.pressEnter())
    await t.settle()
    expect(t.frame()).not.toContain("Load session?")
    expect(switched).toBe("sid-a")
    t.destroy()
  })

  test("drops 0-msg stub rows from RPC list", async () => {
    const gw = new MockGateway({
      "session.list": () => ({ sessions: [
        ...ROWS,
        { id: "stub", title: "", preview: "", message_count: 0, started_at: 1700000001, source: "tui" },
      ]}),
    })
    const t = await mountNode(<Sessions focused io={NOIO} />, { gw })
    await until(t, () => t.frame().includes("Sessions (2)"))
    expect(t.frame()).not.toContain("stub")
    t.destroy()
  })

  test("paints fs rows before RPC resolves; spinner when fs empty (gsk.11)", async () => {
    let unblock!: () => void
    const gate = new Promise<void>(r => { unblock = r })
    const gw = new MockGateway({
      "session.list": async () => { await gate; return { sessions: ROWS } },
    })
    const disk = [{
      id: "sid-disk", title: "From disk", lastMessage: "hey", message_count: 3,
      started_at: 1700000000, sessionSource: "cli", subagent_count: 0,
    }]
    const t = await mountNode(
      <Sessions focused io={{ ...NOIO, list: () => disk as never }} />, { gw },
    )
    // RPC still pending — optimistic fs paint is up.
    await until(t, () => t.frame().includes("From disk"))
    expect(t.frame()).toContain("Sessions (1…)")
    unblock()
    await until(t, () => t.frame().includes("Sessions (3)"))
    expect(t.frame()).toContain("From disk")
    expect(t.frame()).toContain("First session")
    expect(t.frame()).not.toContain("…)")
    t.destroy()

    // No fs rows: spinner covers the gap, then resolves to empty-state.
    let unblock2!: () => void
    const gate2 = new Promise<void>(r => { unblock2 = r })
    const gw2 = new MockGateway({
      "session.list": async () => { await gate2; return { sessions: [] } },
    })
    const t2 = await mountNode(<Sessions focused io={NOIO} />, { gw: gw2 })
    await until(t2, () => t2.frame().includes("loading sessions"))
    expect(t2.frame()).not.toContain("No sessions found")
    unblock2()
    await until(t2, () => t2.frame().includes("No sessions found"))
    t2.destroy()
  })

  test("RPC failure surfaces warning and falls back", async () => {
    const gw = new MockGateway({
      "session.list": () => { throw new Error("gateway unreachable") },
    })
    const t = await mountNode(<Sessions focused io={NOIO} />, { gw })
    // io.list returns [] → empty-state; warning text embedded in error slot
    await until(t, () => {
      const f = t.frame()
      return f.includes("gateway unreachable") || f.includes("No sessions found")
    })
    t.destroy()
  })

  test("/ opens search, queries io.search, Enter switches to hit", async () => {
    const calls: string[] = []
    const search = (q: string): SessionHit[] => {
      calls.push(q)
      return [{
        session_id: "sid-hit", title: `Match for ${q}`,
        snippet: "…found >>>needle<<< here…", role: "user",
        source: "tui", model: "test-model", started_at: 1700000000,
      }]
    }
    const gw = new MockGateway({ "session.list": () => ({ sessions: ROWS }) })
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={{ ...NOIO, search }} onSwitch={sid => { switched = sid }} />,
      { gw },
    )
    await until(t, () => t.frame().includes("Sessions (2)"))

    await act(async () => { await t.keys.typeText("/") })
    await t.settle()
    expect(t.frame()).toContain("Search Results")

    await act(async () => { await t.keys.typeText("needle") })
    await until(t, () => t.frame().includes("Match for needle"))

    // Debounced — intermediate keystrokes dropped, only final query ran.
    expect(calls).toEqual(["needle"])
    // snippet highlight markers stripped from display
    expect(t.frame()).not.toContain(">>>")

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Load session?"))
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(switched).toBe("sid-hit")

    act(() => t.keys.pressEscape())
    await until(t, () => t.frame().includes("Sessions (2)"))
    t.destroy()
  })

  test("d confirms then deletes via session.delete RPC and reloads", async () => {
    let listed = ROWS
    const gw = new MockGateway({
      "session.list": () => ({ sessions: listed }),
      "session.delete": (p) => {
        listed = listed.filter(r => r.id !== p.session_id)
        return { deleted: p.session_id }
      },
    })
    const remove = () => { throw new Error("should use RPC, not direct delete") }
    const t = await mountNode(<Sessions focused io={{ ...NOIO, remove }} />, { gw })
    await until(t, () => t.frame().includes("Sessions (2)"))

    await act(async () => { await t.keys.typeText("d") })
    await until(t, () => t.frame().includes("Delete Session?"))
    expect(t.frame()).toContain("First session")

    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => t.frame().includes("Sessions (1)"))

    expect(t.gw.last("session.delete")?.params.session_id).toBe("sid-a")
    expect(t.frame()).not.toContain("First session")
    expect(t.frame()).toContain("Second session")
    t.destroy()
  })

  test("session.delete 'active' error surfaces toast, no local fallback", async () => {
    const gw = new MockGateway({
      "session.list": () => ({ sessions: ROWS }),
      "session.delete": () => { throw new Error("cannot delete an active session") },
    })
    let local = 0
    const t = await mountNode(<Sessions focused io={{ ...NOIO, remove: () => (local++, true) }} />, { gw })
    await until(t, () => t.frame().includes("Sessions (2)"))

    await act(async () => { await t.keys.typeText("d") })
    await until(t, () => t.frame().includes("Delete Session?"))
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => t.frame().includes("active session"))

    expect(local).toBe(0)
    expect(t.frame()).toContain("Sessions (2)")
    t.destroy()
  })

  test("session.delete unavailable falls back to io.remove", async () => {
    const deleted: string[] = []
    let listed = ROWS
    const gw = new MockGateway({
      "session.list": () => ({ sessions: listed }),
      "session.delete": () => { throw new Error("Method not found") },
    })
    const remove = (sid: string) => {
      deleted.push(sid)
      listed = listed.filter(r => r.id !== sid)
      return true
    }
    const t = await mountNode(<Sessions focused io={{ ...NOIO, remove }} />, { gw })
    await until(t, () => t.frame().includes("Sessions (2)"))

    await act(async () => { await t.keys.typeText("d") })
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => t.frame().includes("Sessions (1)"))

    expect(deleted).toEqual(["sid-a"])
    t.destroy()
  })

  test("Ctrl+R renames selected session via io.rename, patches row in place", async () => {
    const calls: Array<[string, string]> = []
    const gw = new MockGateway({ "session.list": () => ({ sessions: ROWS }) })
    const rename = (sid: string, title: string) => { calls.push([sid, title]); return true }
    const t = await mountNode(<Sessions focused io={{ ...NOIO, rename }} />, { gw })
    await until(t, () => t.frame().includes("First session"))

    act(() => t.keys.pressKey("r", { ctrl: true }))
    await until(t, () => t.frame().includes("Rename: First session"))
    // initial seeded from current title
    expect(t.frame()).toContain("First session")
    // Ctrl+U clear, then type new title
    await act(async () => { await t.keys.pressKey("u", { ctrl: true }) })
    for (const c of "Renamed A") await act(async () => { await t.keys.typeText(c) })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Renamed A"))

    expect(calls).toEqual([["sid-a", "Renamed A"]])
    expect(t.frame()).not.toContain("First session")
    // No reload fired — only the initial session.list.
    expect(t.gw.calls.filter(c => c.method === "session.list").length).toBe(1)
    t.destroy()
  })

  test("click on row switches to that session", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: ROWS }) })
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={NOIO} onSwitch={sid => { switched = sid }} />,
      { gw, width: 160, height: 48 },
    )
    await until(t, () => t.frame().includes("Second session"))

    const lines = t.frame().split("\n")
    const y = lines.findIndex(l => l.includes("Second session"))
    const x = lines[y].indexOf("Second session")
    await act(async () => { await t.mouse.pressDown(x, y) })
    await until(t, () => t.frame().includes("Load session?"))
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(switched).toBe("sid-b")
    t.destroy()
  })

  test("columns reflow on resize — title grows/shrinks, meta stays aligned", async () => {
    const long = "A rather long session title that definitely exceeds thirty characters"
    const gw = new MockGateway({
      "session.list": () => ({ sessions: [
        { id: "sid-long", title: long, preview: "", message_count: 7, started_at: 1700000000, source: "tui" },
      ]}),
    })
    const t = await mountNode(<Sessions focused io={NOIO} />, { gw, width: 200, height: 30 })
    await until(t, () => t.frame().includes("Sessions (1)"))

    const row = (f: string) => f.split("\n").find(l => l.includes("▸ A rather"))!
    const titleLen = (f: string) => {
      const r = row(f)
      return r.indexOf("TUI") - r.indexOf("A rather")
    }

    const wide = t.frame()
    // Header row present, value under Msgs column
    expect(wide).toMatch(/Title\s+Source\s+Start\s+Active\s+Msgs/)
    // started_at fixture is Nov 2023 → date, not HH:MM.
    expect(row(wide)).toMatch(/TUI\s+\w{3} \d+\s+—\s+7/)
    // Full title visible at 200 cols
    expect(row(wide)).toContain("exceeds thirty characters")

    t.resize(110, 30)
    await t.settle()
    await t.settle()
    const narrow = t.frame()

    // Detail panel hidden <140; meta column still present; title column shrank
    expect(narrow).not.toContain("Session Detail")
    expect(row(narrow)).toContain("TUI")
    expect(titleLen(narrow)).toBeLessThan(titleLen(wide))
    // Truncated, not wrapped to a second line
    expect(narrow.split("\n").filter(l => /▸.*A rather/.test(l)).length).toBe(1)
    // Header doesn't wrap at narrow width either
    const headerY = narrow.split("\n").findIndex(l => l.includes("Sessions (1)"))
    expect(narrow.split("\n")[headerY + 1]).not.toContain("refresh")
    t.destroy()
  })

  test("column headers align with data rows", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `sid-${i}`, title: `Session ${i}`, preview: "",
      message_count: i + 1, started_at: 1700000000 - i * 60, source: "tui",
    }))
    const gw = new MockGateway({ "session.list": () => ({ sessions: many }) })
    const t = await mountNode(<Sessions focused io={NOIO} />, { gw, width: 200, height: 20 })
    await until(t, () => t.frame().includes("Sessions (60)"))

    // Header labels sit at the same x as data values — including when
    // the vbar is visible (it carves 1 col out of the body; header
    // mirrors it via paddingRight=VBAR_W, vbar forced always visible).
    const lines = t.frame().split("\n")
    const hdr = lines.find(l => /Title\s+Source\s+Start\s+Active\s+Msgs/.test(l))!
    const row = lines.find(l => l.includes("▸ Session 0"))!
    expect(hdr.indexOf("Title")).toBe(row.indexOf("Session 0"))
    expect(hdr.indexOf("Source")).toBe(row.indexOf("TUI"))
    // Right-aligned Msgs column ends at same x.
    const hdrMsgsEnd = hdr.indexOf("Msgs") + 4
    const rowMsgsEnd = row.search(/\d+(\s+✕)/) + row.match(/(\d+)\s+✕/)![1].length
    expect(rowMsgsEnd).toBe(hdrMsgsEnd)
    t.destroy()
  })

  test("key-nav ignores synthetic hover from scroll-under-cursor (stutter regression)", async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      id: `sid-${i}`, title: `Session ${i}`, preview: "",
      message_count: i + 1, started_at: 1700000000 - i * 60, source: "tui",
    }))
    const gw = new MockGateway({ "session.list": () => ({ sessions: many }) })
    const t = await mountNode(<Sessions focused io={NOIO} />, { gw, width: 120, height: 20 })
    await until(t, () => t.frame().includes("Sessions (80)"))

    // Park the cursor over a visible row.
    const rowY = (f: string, n: number) =>
      f.split("\n").findIndex(l => l.includes(`Session ${n} `))
    await act(async () => { await t.mouse.moveTo(10, rowY(t.frame(), 3)) })
    await t.settle()
    expect(t.frame()).toContain("▸ Session 3")

    // Drive ↓ past the viewport — scrollChildIntoView moves rows under
    // the parked cursor. With onMouseOver this fired hover→snap-back;
    // with onMouseMove it doesn't, so sel lands at 33.
    for (let k = 0; k < 30; k++) act(() => t.keys.pressArrow("down"))
    await t.settle(); await t.settle()
    const selLine = t.frame().split("\n").find(l => l.includes("▸ Session "))!
    expect(Number(selLine.match(/Session (\d+)/)![1])).toBe(33)

    // Real pointer motion still selects.
    await act(async () => { await t.mouse.moveTo(10, rowY(t.frame(), 30)) })
    await t.settle()
    expect(t.frame()).toContain("▸ Session 30")
    t.destroy()
  })

  test("handles full list; arrow/PgDn/End scroll viewport", async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      id: `sid-${i}`, title: `Session ${i}`, preview: "",
      message_count: i + 1, started_at: 1700000000 - i * 60, source: "tui",
    }))
    const gw = new MockGateway({ "session.list": () => ({ sessions: many }) })
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={NOIO} onSwitch={sid => { switched = sid }} />,
      { gw, width: 160, height: 30 },
    )
    await until(t, () => t.frame().includes("Sessions (300)"))
    expect(t.gw.last("session.list")?.params.limit).toBe(2000)

    // Selected row visible; rows past viewport culled from frame.
    expect(t.frame()).toContain("▸ Session 0")
    expect(t.frame()).not.toContain("Session 100")

    // End → last row scrolled into view.
    act(() => t.keys.pressKey("END"))
    await t.settle(); await t.settle()
    expect(t.frame()).toContain("▸ Session 299")
    expect(t.frame()).not.toContain("Session 0 ")

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Load session?"))
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(switched).toBe("sid-299")

    // Home → back to top.
    act(() => t.keys.pressKey("HOME"))
    await t.settle(); await t.settle()
    expect(t.frame()).toContain("▸ Session 0")

    // PgDn jumps ~viewport height; selection stays in view.
    act(() => t.keys.pressKey("\x1B[57355u"))  // kitty: pagedown
    await t.settle(); await t.settle()
    let selLine = t.frame().split("\n").find(l => l.includes("▸ Session "))!
    const firstJump = Number(selLine.match(/Session (\d+)/)![1])
    expect(firstJump).toBeGreaterThan(10)
    // Second PgDn scrolls the viewport past row 0.
    act(() => t.keys.pressKey("\x1B[57355u"))
    await t.settle(); await t.settle()
    const f = t.frame()
    selLine = f.split("\n").find(l => l.includes("▸ Session "))!
    expect(Number(selLine.match(/Session (\d+)/)![1])).toBe(firstJump * 2)
    expect(f).not.toContain("Session 0 ")
    t.destroy()
  })

  test("detail panel clips (does not overflow) at short height", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: ROWS }) })
    const t = await mountNode(<Sessions focused io={NOIO} />, { gw, width: 180, height: 12 })
    await until(t, () => t.frame().includes("Sessions (2)"))

    const f = t.frame()
    expect(f).toContain("Session Detail")
    // Transcript section doesn't fit at h=12 with the metadata block
    // above it; it's clipped rather than painted past the border.
    expect(f).not.toContain("Transcript")
    // Bottom border intact (no content bleeding through it).
    const last = f.split("\n").filter(l => l.trim()).at(-1)!
    expect(last).toMatch(/└─+┘└─+┘$/)
    t.destroy()
  })
})

// ─── Tree expansion (herm-gsk.15) ────────────────────────────────────
//
// When a parent row has detail.subagent_count > 0, focusing it should
// trigger io.subagents(parentId), render each child indented with "└─",
// and let arrow keys traverse in/out of the child block. Only one
// parent expands at a time; moving to another collapses the first.

import type { SessionRow } from "../src/utils/hermes-home"

// Stub SessionRow fields we actually consume; zero the rest.
const detail = (over: Partial<SessionRow> & { id: string; sessionSource: string }): SessionRow => ({
  source: { file: "/tmp/state.db", relative: "state.db", label: "state.db" },
  model: null, started_at: 1699999000, ended_at: null, end_reason: null,
  message_count: 0, tool_call_count: 0,
  input_tokens: 0, output_tokens: 0,
  cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
  estimated_cost_usd: null, title: null, lastMessage: null, last_active: null,
  parent_session_id: null, subagent_count: 0, lineage_root_id: null,
  ...over,
})

describe("Sessions tab — tree expansion", () => {
  const PARENT = { id: "pid", title: "Parent with subs", preview: "", message_count: 3, started_at: 1700000000, source: "tui" }
  const OTHER  = { id: "oid", title: "Other parent",     preview: "", message_count: 2, started_at: 1699999000, source: "cli" }
  const SUB1   = detail({ id: "sub-1", sessionSource: "tui", title: "First subagent",  message_count: 5, started_at: 1700000100 })
  const SUB2   = detail({ id: "sub-2", sessionSource: "tui", title: "Second subagent", message_count: 7, started_at: 1700000200 })

  const listWithSubs = (): SessionRow[] => [
    detail({ id: "pid", sessionSource: "tui", title: "Parent with subs",
             message_count: 3, started_at: 1700000000, subagent_count: 2 }),
    detail({ id: "oid", sessionSource: "cli", title: "Other parent",
             message_count: 2, started_at: 1699999000 }),
  ]

  const subsFor = (calls: string[]) => (pid: string) => {
    calls.push(pid)
    if (pid === "pid") return [SUB1, SUB2]
    return []
  }

  test("focusing a parent with subagents loads and renders children indented", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT, OTHER] }) })
    const calls: string[] = []
    const io = { ...NOIO, list: listWithSubs, subagents: subsFor(calls) }
    const t = await mountNode(<Sessions focused io={io} />, { gw, width: 180, height: 30 })
    await until(t, () => t.frame().includes("Sessions (2)"))

    // Selection starts on the first parent (pid) → children should load.
    await until(t, () => calls.includes("pid"))
    await until(t, () => t.frame().includes("First subagent"))
    const f = t.frame()
    // Parent row unchanged, indented children below with "└─".
    expect(f).toContain("▸ Parent with subs")
    expect(f).toContain("└─First subagent")
    expect(f).toContain("└─Second subagent")
    // Header count still reflects PARENT rows only, not flat visible count.
    expect(f).toContain("Sessions (2)")
    t.destroy()
  })

  test("arrow down enters children, arrow up exits", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT, OTHER] }) })
    const io = { ...NOIO, list: listWithSubs, subagents: subsFor([]) }
    const t = await mountNode(<Sessions focused io={io} />, { gw, width: 180, height: 30 })
    await until(t, () => t.frame().includes("First subagent"))

    // ↓ once: selection moves onto the first child.
    act(() => t.keys.pressArrow("down"))
    await t.settle()
    expect(t.frame()).toMatch(/└─First subagent/)
    // Selected row carries the accent marker — children use "└─" so
    // check the selected background by looking at the sel-highlight
    // with the active row's title.
    // (OpenTUI rendering obscures exact ANSI here; proxy: the next ↓
    //  moves onto the 2nd child.)
    act(() => t.keys.pressArrow("down"))
    await t.settle()
    // ↓ again: selection leaves children and lands on OTHER parent;
    // the first parent's children collapse since expansion follows sel.
    act(() => t.keys.pressArrow("down"))
    await t.settle()
    const f = t.frame()
    expect(f).toContain("▸ Other parent")
    expect(f).not.toContain("First subagent")  // collapsed
    t.destroy()
  })

  test("clicking a child row switches to that child session", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT, OTHER] }) })
    const io = { ...NOIO, list: listWithSubs, subagents: subsFor([]) }
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={io} onSwitch={sid => { switched = sid }} />,
      { gw, width: 180, height: 30 },
    )
    await until(t, () => t.frame().includes("First subagent"))

    const lines = t.frame().split("\n")
    const y = lines.findIndex(l => l.includes("Second subagent"))
    const x = lines[y].indexOf("Second subagent")
    await act(async () => { await t.mouse.pressDown(x, y) })
    await until(t, () => t.frame().includes("Load session?"))
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(switched).toBe("sub-2")
    t.destroy()
  })

  test("detail panel reflects the selected row (parent or child)", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT, OTHER] }) })
    const io = { ...NOIO, list: listWithSubs, subagents: subsFor([]) }
    const t = await mountNode(<Sessions focused io={io} />, { gw, width: 200, height: 40 })
    await until(t, () => t.frame().includes("First subagent"))

    // Parent selected → detail shows parent title.
    expect(t.frame()).toContain("Parent with subs")
    // Move selection to first child.
    act(() => t.keys.pressArrow("down"))
    await t.settle()
    // Detail panel should now render the child's title.
    await until(t, () => t.frame().includes("First subagent"))
    expect(t.frame()).toContain("First subagent")
    t.destroy()
  })

  test("moving to a parent with no children shows no expansion", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT, OTHER] }) })
    const io = { ...NOIO, list: listWithSubs, subagents: subsFor([]) }
    const t = await mountNode(<Sessions focused io={io} />, { gw, width: 180, height: 30 })
    await until(t, () => t.frame().includes("First subagent"))

    // Move all the way down to OTHER (3 steps: sub1, sub2, OTHER).
    for (let i = 0; i < 3; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    const f = t.frame()
    expect(f).toContain("▸ Other parent")
    expect(f).not.toContain("First subagent")
    t.destroy()
  })

  test("parent with subagent_count=0 does not call io.subagents", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [OTHER] }) })
    const calls: string[] = []
    const list = (): SessionRow[] => [
      detail({ id: "oid", sessionSource: "cli", title: "Other parent", message_count: 2, subagent_count: 0 }),
    ]
    const io = { ...NOIO, list, subagents: (pid: string) => { calls.push(pid); return [] } }
    const t = await mountNode(<Sessions focused io={io} />, { gw, width: 180, height: 30 })
    await until(t, () => t.frame().includes("Sessions (1)"))
    await t.settle()
    expect(calls).toEqual([])
    t.destroy()
  })

  test("arrow down past last child lands on the NEXT parent, not the one after (3+ parents)", async () => {
    // Regression: with the old effect cascade (auto-expand → re-render →
    // clamp), the collapse shrinks visible[] by N children and the clamp
    // then snaps sel to length-1, overshooting the intended next parent.
    const THIRD = { id: "cid", title: "Third parent", preview: "", message_count: 1, started_at: 1699998000, source: "tui" }
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT, OTHER, THIRD] }) })
    const list = (): SessionRow[] => [
      detail({ id: "pid", sessionSource: "tui", title: "Parent with subs", message_count: 3, started_at: 1700000000, subagent_count: 2 }),
      detail({ id: "oid", sessionSource: "cli", title: "Other parent",     message_count: 2, started_at: 1699999000 }),
      detail({ id: "cid", sessionSource: "tui", title: "Third parent",     message_count: 1, started_at: 1699998000 }),
    ]
    const io = { ...NOIO, list, subagents: subsFor([]) }
    const t = await mountNode(<Sessions focused io={io} />, { gw, width: 180, height: 30 })
    await until(t, () => t.frame().includes("First subagent"))

    // sel=0 (PARENT) → ↓×3 = sub1, sub2, OTHER. Must NOT skip to THIRD.
    for (let i = 0; i < 3; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    await t.settle()
    expect(t.frame()).toContain("▸ Other parent")
    expect(t.frame()).not.toContain("▸ Third parent")
    t.destroy()
  })

  test("arrow up from the next parent lands on the EXPANDED parent, not inside its children", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT, OTHER] }) })
    const io = { ...NOIO, list: listWithSubs, subagents: subsFor([]) }
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={io} onSwitch={sid => { switched = sid }} />,
      { gw, width: 180, height: 30 },
    )
    await until(t, () => t.frame().includes("First subagent"))

    // Walk down through the children to OTHER, then back up one step.
    for (let i = 0; i < 3; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    expect(t.frame()).toContain("▸ Other parent")
    expect(t.frame()).not.toContain("First subagent")

    act(() => t.keys.pressArrow("up")); await t.settle()
    // Anchor moved to PARENT in the collapsed layout; expansion is
    // derived from anchor, so PARENT re-expands with sel on itself —
    // not its last child. Simpler than entering children from below.
    expect(t.frame()).toContain("▸ Parent with subs")
    expect(t.frame()).toContain("└─First subagent")
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Load session?"))
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(switched).toBe("pid")
    t.destroy()
  })
})

// ─── Lineage block in detail panel (herm-gsk.16) ─────────────────────

describe("Sessions tab — lineage block", () => {
  const PARENT_COMP = { id: "rid", title: "Root",      preview: "", message_count: 5, started_at: 1700000000, source: "tui" }
  const PARENT_CONT = { id: "tid", title: "Live tip",  preview: "", message_count: 2, started_at: 1700001100, source: "tui" }
  const PARENT_WITH_SUBS = { id: "pid", title: "Parent with subs", preview: "", message_count: 3, started_at: 1700002000, source: "tui" }

  test("row projected from a compression chain shows ← continues from", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT_CONT] }) })
    const list = (): SessionRow[] => [
      detail({ id: "tid", sessionSource: "tui", title: "Live tip",
               started_at: 1700000000, message_count: 2, lineage_root_id: "rid" }),
    ]
    const lineage = () => ({ continuesFrom: { id: "rid", title: "Original root title" } })
    const io = { ...NOIO, list, lineage }
    const t = await mountNode(<Sessions focused io={io} />, { gw, width: 200, height: 40 })
    await until(t, () => t.frame().includes("Live tip"))
    const f = t.frame()
    expect(f).toContain("Lineage")
    expect(f).toContain("← continues from")
    expect(f).toContain("Original root title")
    t.destroy()
  })

  test("row with compression successor shows → compressed to", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT_COMP] }) })
    const list = (): SessionRow[] => [
      detail({ id: "rid", sessionSource: "tui", title: "Root", message_count: 5, end_reason: "compression" }),
    ]
    const lineage = () => ({ compressedTo: { id: "tid", title: "Live tip" } })
    const io = { ...NOIO, list, lineage }
    const t = await mountNode(<Sessions focused io={io} />, { gw, width: 200, height: 40 })
    await until(t, () => t.frame().includes("Root"))
    const f = t.frame()
    expect(f).toContain("→ compressed to")
    expect(f).toContain("Live tip")
    t.destroy()
  })

  test("parent with subagents shows ⎇ spawned N subagents", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT_WITH_SUBS] }) })
    const list = (): SessionRow[] => [
      detail({ id: "pid", sessionSource: "tui", title: "Parent with subs", message_count: 3, subagent_count: 2 }),
    ]
    const io = { ...NOIO, list, lineage: () => ({}) }
    const t = await mountNode(<Sessions focused io={io} />, { gw, width: 200, height: 40 })
    await until(t, () => t.frame().includes("Parent with subs"))
    expect(t.frame()).toContain("⎇ spawned 2 subagents")
    t.destroy()
  })

  test("plain row with no lineage has no Lineage block", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT_WITH_SUBS] }) })
    const list = (): SessionRow[] => [
      detail({ id: "pid", sessionSource: "tui", title: "Parent with subs", message_count: 3 }),
    ]
    const io = { ...NOIO, list, lineage: () => ({}) }
    const t = await mountNode(<Sessions focused io={io} />, { gw, width: 200, height: 40 })
    await until(t, () => t.frame().includes("Parent with subs"))
    expect(t.frame()).not.toContain("Lineage")
    expect(t.frame()).not.toContain("continues from")
    expect(t.frame()).not.toContain("compressed to")
    t.destroy()
  })

  test("clicking ← continues from switches to predecessor session", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT_CONT] }) })
    const list = (): SessionRow[] => [
      detail({ id: "tid", sessionSource: "tui", title: "Live tip", message_count: 2 }),
    ]
    const lineage = () => ({ continuesFrom: { id: "rid", title: "Original root title" } })
    const io = { ...NOIO, list, lineage }
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={io} onSwitch={sid => { switched = sid }} />,
      { gw, width: 200, height: 40 },
    )
    await until(t, () => t.frame().includes("Original root title"))

    const lines = t.frame().split("\n")
    const y = lines.findIndex(l => l.includes("Original root title"))
    const x = lines[y].indexOf("Original root title")
    await act(async () => { await t.mouse.pressDown(x, y) })
    await until(t, () => t.frame().includes("Load session?"))
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(switched).toBe("rid")
    t.destroy()
  })
})

// ─── Transcript peek (herm-5r2) ──────────────────────────────────────

const pm = (role: PeekMsg["role"], content: string | null, extra: Partial<PeekMsg> = {}): PeekMsg =>
  ({ role, content, tool_name: null, tool_calls: null, at: 0, ...extra })

describe("fold() — reduce raw message rows for peek", () => {
  test("user/assistant text pass through; tools counted", () => {
    expect(fold([pm("user", "hi"), pm("assistant", "hello")])).toEqual({
      turns: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ],
      tools: 0,
    })
  })

  test("tool results are counted, not rendered; empty assistant dropped", () => {
    expect(fold([
      pm("user", "run it"),
      pm("assistant", null, { tool_calls: '[{"name":"terminal"},{"name":"read_file"}]' }),
      pm("tool", "out1", { tool_name: "terminal" }),
      pm("tool", "out2", { tool_name: "read_file" }),
      pm("assistant", "done"),
    ])).toEqual({
      turns: [
        { role: "user", text: "run it" },
        { role: "assistant", text: "done" },
      ],
      tools: 2,
    })
  })

  test("assistant with BOTH content and tool_calls keeps the text row", () => {
    expect(fold([
      pm("assistant", "thinking…", { tool_calls: '[{"name":"search"}]' }),
      pm("tool", "hit", { tool_name: "search" }),
      pm("assistant", "found it"),
    ])).toEqual({
      turns: [
        { role: "assistant", text: "thinking…" },
        { role: "assistant", text: "found it" },
      ],
      tools: 1,
    })
  })

  test("system rows dropped; whitespace collapsed", () => {
    expect(fold([
      pm("system", "memory flush"),
      pm("user", "line1\n\n  line2"),
    ])).toEqual({ turns: [{ role: "user", text: "line1 line2" }], tools: 0 })
  })

  test("pure tool session → no turns, tools counted", () => {
    expect(fold([
      pm("assistant", null, { tool_calls: "[…]" }),
      pm("tool", "a", { tool_name: "terminal" }),
      pm("tool", "b", { tool_name: "terminal" }),
      pm("tool", "c", { tool_name: "patch" }),
    ])).toEqual({ turns: [], tools: 3 })
  })
})

describe("Sessions tab — transcript peek", () => {
  test("renders user left-bar / assistant right-bar; footer shows tool count", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: ROWS }) })
    const peek = (sid: string): PeekMsg[] => sid === "sid-a" ? [
      pm("user", "please fix the parser"),
      pm("assistant", null, { tool_calls: '[{"name":"read_file"}]' }),
      pm("tool", "file content", { tool_name: "read_file" }),
      pm("assistant", "Found it — missing brace on line 42."),
    ] : []
    const t = await mountNode(<Sessions focused io={{ ...NOIO, peek }} />, { gw, width: 200, height: 50 })
    await until(t, () => t.frame().includes("Transcript"))

    const lines = t.frame().split("\n")
    // User row: bar at left edge of detail content area, text follows.
    const u = lines.find(l => l.includes("please fix the parser"))!
    expect(u).toMatch(/│ please fix the parser/)
    // Assistant row: bar at right edge.
    const a = lines.find(l => l.includes("missing brace"))!
    expect(a).toMatch(/missing brace on line 42\.\s*│/)
    // No tool rows rendered; footer has the count.
    expect(t.frame()).not.toContain("read_file")
    expect(t.frame()).toContain("2 turns  ·  1 tool call")
    t.destroy()
  })

  test("peek re-queries when selection changes; empty → '(no local transcript)'", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: ROWS }) })
    const calls: string[] = []
    const peek = (sid: string): PeekMsg[] => {
      calls.push(sid)
      return sid === "sid-a" ? [pm("user", "alpha content here")] : []
    }
    const t = await mountNode(<Sessions focused io={{ ...NOIO, peek }} />, { gw, width: 200, height: 50 })
    await until(t, () => t.frame().includes("alpha content here"))
    expect(calls).toContain("sid-a")

    act(() => t.keys.pressArrow("down"))
    await until(t, () => t.frame().includes("(no local transcript)"))
    expect(calls).toContain("sid-b")
    expect(t.frame()).not.toContain("alpha content here")
    t.destroy()
  })

  test("tool-only session still shows footer (not 'no local transcript')", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: ROWS }) })
    const peek = (): PeekMsg[] => [
      pm("assistant", null, { tool_calls: "[…]" }),
      pm("tool", "x", { tool_name: "terminal" }),
      pm("tool", "y", { tool_name: "terminal" }),
    ]
    const t = await mountNode(<Sessions focused io={{ ...NOIO, peek }} />, { gw, width: 200, height: 50 })
    await until(t, () => t.frame().includes("Transcript"))
    expect(t.frame()).toContain("0 turns  ·  2 tool calls")
    expect(t.frame()).not.toContain("(no local transcript)")
    t.destroy()
  })
})

// ─── Lineage nav (herm-ngy) ──────────────────────────────────────────
//
// ←/→ walk the compression chain from the focused row. Tests verify:
//   • → jumps to compressedTo.id via onSwitch (after confirm)
//   • ← jumps to continuesFrom.id via onSwitch (after confirm)
//   • keys at a row without that lineage field do nothing (no confirm)
//   • io.lineage is queried on demand per keypress (not cached at mount)

describe("Sessions tab — lineage keyboard nav (herm-ngy)", () => {
  const LINEAGE_ROWS = [
    { id: "sid-root", title: "Root", preview: "", message_count: 5, started_at: 1700000000, source: "tui" },
    { id: "sid-mid",  title: "Middle", preview: "", message_count: 7, started_at: 1700000100, source: "tui" },
    { id: "sid-tip",  title: "Tip", preview: "", message_count: 3, started_at: 1700000200, source: "tui" },
  ]

  // Chain: root ← mid ← tip (tip continues from mid, which continues from root).
  const lineageMap: Record<string, { continuesFrom?: { id: string; title: string | null }; compressedTo?: { id: string; title: string | null } }> = {
    "sid-root": { compressedTo: { id: "sid-mid", title: "Middle" } },
    "sid-mid":  { continuesFrom: { id: "sid-root", title: "Root" }, compressedTo: { id: "sid-tip", title: "Tip" } },
    "sid-tip":  { continuesFrom: { id: "sid-mid", title: "Middle" } },
  }
  const lineage = (sid: string) => lineageMap[sid] ?? {}

  test("→ from root jumps forward to compressedTo via confirm", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: LINEAGE_ROWS }) })
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={{ ...NOIO, lineage }} onSwitch={sid => { switched = sid }} />,
      { gw },
    )
    await until(t, () => t.frame().includes("Sessions (3)"))
    // Table sort is oldest-first, so visible[0] = sid-root (Root on top).
    // Press → to go to its compressedTo (sid-mid).
    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("Load session?"))
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(switched).toBe("sid-mid")
    t.destroy()
  })

  test("← from tip jumps backward to continuesFrom via confirm", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: LINEAGE_ROWS }) })
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={{ ...NOIO, lineage }} onSwitch={sid => { switched = sid }} />,
      { gw },
    )
    await until(t, () => t.frame().includes("Sessions (3)"))
    // Walk down to sid-tip (last in oldest-first sort).
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressArrow("down")); await t.settle()
    // ← from tip → continuesFrom (sid-mid).
    act(() => t.keys.pressArrow("left"))
    await until(t, () => t.frame().includes("Load session?"))
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(switched).toBe("sid-mid")
    t.destroy()
  })

  test("arrow at tip without compressedTo is a no-op (no confirm, no switch)", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: LINEAGE_ROWS }) })
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={{ ...NOIO, lineage }} onSwitch={sid => { switched = sid }} />,
      { gw },
    )
    await until(t, () => t.frame().includes("Sessions (3)"))
    // Walk to sid-tip (last), which has NO compressedTo. → should do nothing.
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressArrow("right"))
    await t.settle()
    expect(t.frame()).not.toContain("Load session?")
    expect(switched).toBe("")
    t.destroy()
  })

  test("arrow at root without continuesFrom is a no-op", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: LINEAGE_ROWS }) })
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={{ ...NOIO, lineage }} onSwitch={sid => { switched = sid }} />,
      { gw },
    )
    await until(t, () => t.frame().includes("Sessions (3)"))
    // sel=0 → sid-root (top of oldest-first sort). ← is no-op (no continuesFrom).
    act(() => t.keys.pressArrow("left"))
    await t.settle()
    expect(t.frame()).not.toContain("Load session?")
    expect(switched).toBe("")
    t.destroy()
  })
})


