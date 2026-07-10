import { describe, test, expect } from "bun:test"
import { act } from "react"
import { TextAttributes } from "@opentui/core"
import { mountNode, until, MockGateway } from "./harness"
import { Sessions, fold } from "../src/tabs/Sessions"
import type { SessionHit } from "../src/service/hermes-home"
import type { SessionRow } from "../src/service/hermes-home"
import type { LineageInfo, PeekMsg } from "../src/service/sessions-db"
import * as prefs from "../src/context/preferences"

const ROWS = [
  { id: "sid-a", title: "First session", preview: "hey", message_count: 4, started_at: 1700000000, source: "tui" },
  { id: "sid-b", title: "Second session", preview: "", message_count: 12, started_at: 1699999000, source: "cli" },
]

const NOIO = { list: () => [], search: () => [], remove: () => true, rename: () => true, subagents: () => [], peek: () => [] }

// Stub SessionRow fields we actually consume; zero the rest.
const detail = (over: Partial<SessionRow> & { id: string; sessionSource: string }): SessionRow => ({
  source: { file: "/tmp/state.db", relative: "state.db", label: "state.db" },
  model: null, billing_provider: null, started_at: 1699999000, ended_at: null, end_reason: null,
  message_count: 0, tool_call_count: 0,
  input_tokens: 0, output_tokens: 0,
  cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
  estimated_cost_usd: null, title: null, lastMessage: null, last_active: null,
  parent_session_id: null, subagent_count: 0, lineage_root_id: null,
  ...over,
})

describe("Sessions tab", () => {
  test("pins active sessions above history without entering an active-only view", async () => {
    const gw = new MockGateway({
      "session.active_list": p => ({ sessions: [
        { id: "live-a", title: "Working live", preview: "do the thing", message_count: 3, started_at: 1700000000, status: "working", current: p.current_session_id === "live-a" },
        { id: "live-b", title: "Idle live", preview: "done", message_count: 1, started_at: 1700000100, status: "idle" },
      ]}),
      "session.list": () => ({ sessions: ROWS }),
    })
    let activated = ""
    const t = await mountNode(
      <Sessions focused io={NOIO} currentId="live-a" onActivateLive={sid => { activated = sid }} />,
      { gw },
    )
    await until(t, () => t.frame().includes("Sessions (4)"))

    const lines = t.frame().split("\n")
    const live = lines.findIndex(l => l.includes("Working live"))
    const div = lines.findIndex(l => l.includes("Conversations"))
    const hist = lines.findIndex(l => l.includes("First session") && l.includes("TUI"))
    expect(live).toBeGreaterThanOrEqual(0)
    expect(div).toBeGreaterThan(live)
    expect(hist).toBeGreaterThan(div)
    expect(t.frame()).toContain("Second session")
    expect(t.frame()).toContain("sort: active")
    expect(t.frame()).not.toContain("Live Sessions")
    expect(t.frame()).not.toContain("live 2")
    expect(t.frame()).not.toContain("history 2")
    expect(t.gw.last("session.active_list")?.params.current_session_id).toBe("live-a")

    act(() => t.keys.pressEnter())
    await t.settle()
    expect(activated).toBe("live-a")
    expect(t.frame()).not.toContain("Load session?")

    t.destroy()
  })

  test("active section keeps real source, placeholder title, and arrow navigation", async () => {
    const gw = new MockGateway({
      "session.active_list": () => ({ sessions: [
        { id: "live-a", title: "", preview: "", message_count: 3, started_at: 1700000000, status: "working" },
      ]}),
      "session.list": () => ({ sessions: ROWS }),
    })
    const disk = [
      detail({ id: "live-a", sessionSource: "tui", message_count: 3, started_at: 1700000000 }),
    ]
    const t = await mountNode(<Sessions focused io={{ ...NOIO, list: () => disk }} />, { gw, width: 110 })
    await until(t, () => t.frame().includes("Sessions (3)"))

    const pos = () => {
      const lines = t.frame().split("\n")
      const active = lines.findIndex(l => l.includes("TUI") && l.includes("3") && l.includes("-"))
      const top = lines.findIndex(l => l.includes("Active Session"))
      const div = lines.findIndex(l => l.includes("Conversations"))
      const hist = lines.findIndex(l => l.includes("First session") && l.includes("TUI"))
      expect(top).toBeGreaterThanOrEqual(0)
      expect(active).toBeGreaterThan(top)
      expect(div).toBeGreaterThan(active)
      expect(hist).toBeGreaterThan(div)
      return { lines, active, hist }
    }

    const before = pos()
    expect(before.lines[before.active]).toContain("▸ -")
    expect(before.lines[before.active]).toContain("TUI")
    expect(before.lines[before.active]).not.toContain("Live")
    expect(t.frame()).not.toContain("live-a")

    act(() => t.keys.pressArrow("down"))
    await t.settle()
    const after = pos()
    expect(after.lines[after.active]).not.toContain("▸")
    expect(after.lines[after.hist]).toContain("▸")

    t.destroy()
  })

  test("active resumed session_key suppresses duplicate history row", async () => {
    const gw = new MockGateway({
      "session.active_list": () => ({ sessions: [
        { id: "live-past", session_key: "past", title: "Past Root", preview: "hello", message_count: 2, started_at: 1700000000, status: "idle" },
      ]}),
      "session.list": () => ({ sessions: [
        { id: "past", title: "Past Root", preview: "hello", message_count: 2, started_at: 1700000000, source: "tui" },
      ]}),
    })
    const disk = [detail({ id: "past", sessionSource: "tui", title: "Past Root", message_count: 2, started_at: 1700000000 })]
    const t = await mountNode(<Sessions focused io={{ ...NOIO, list: () => disk }} currentId="live-past" />, { gw, width: 110 })
    await until(t, () => t.frame().includes("Sessions (1)") && t.frame().includes("Past Root"))

    expect(t.frame()).toContain("Active Session")
    expect(t.frame()).toContain("TUI")
    expect(t.frame()).not.toContain("Conversations")
    expect(t.frame()).not.toContain("[←→] filter")
    expect(t.frame()).not.toContain("History")

    t.destroy()
  })

  test("Ctrl+R renames active session via session.title", async () => {
    const calls: Array<[string, string]> = []
    const gw = new MockGateway({
      "session.active_list": () => ({ sessions: [
        { id: "live-past", session_key: "past", title: "Past Root", preview: "hello", message_count: 2, started_at: 1700000000, status: "idle" },
      ]}),
      "session.list": () => ({ sessions: [
        { id: "past", title: "Past Root", preview: "hello", message_count: 2, started_at: 1700000000, source: "tui" },
      ]}),
      "session.title": p => ({ title: p.title }),
    })
    const disk = [detail({ id: "past", sessionSource: "tui", title: "Past Root", message_count: 2, started_at: 1700000000 })]
    const rename = (sid: string, title: string) => { calls.push([sid, title]); return false }
    const t = await mountNode(<Sessions focused io={{ ...NOIO, list: () => disk, rename }} currentId="live-past" />, { gw, width: 120 })
    await until(t, () => t.frame().includes("Sessions (1)") && t.frame().includes("Past Root"))

    act(() => t.keys.pressKey("r", { ctrl: true }))
    await until(t, () => t.frame().includes("Rename: Past Root"))
    await act(async () => { await t.keys.pressKey("u", { ctrl: true }) })
    for (const c of "Renamed Active") await act(async () => { await t.keys.typeText(c) })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Renamed Active"))

    expect(gw.last("session.title")?.params).toEqual({ session_id: "live-past", title: "Renamed Active" })
    expect(calls).toEqual([])
    expect(t.frame()).not.toContain("Past Root")
    t.destroy()
  })

  test("session.title event patches the matching sidebar row", async () => {
    const gw = new MockGateway({
      "session.active_list": () => ({ sessions: [
        { id: "live-past", session_key: "past", title: "Past Root", preview: "hello", message_count: 2, started_at: 1700000000, status: "idle" },
      ]}),
      "session.list": () => ({ sessions: [
        { id: "past", title: "Past Root", preview: "hello", message_count: 2, started_at: 1700000000, source: "tui" },
      ]}),
    })
    const disk = [detail({ id: "past", sessionSource: "tui", title: "Past Root", message_count: 2, started_at: 1700000000 })]
    const t = await mountNode(<Sessions focused io={{ ...NOIO, list: () => disk }} currentId="live-past" />, { gw, width: 120 })
    await until(t, () => t.frame().includes("Sessions (1)") && t.frame().includes("Past Root"))

    act(() => gw.push({
      type: "session.title",
      payload: { session_id: "live-past", title: "Generated Active" },
    }))
    await until(t, () => t.frame().includes("Generated Active"))

    expect(t.frame()).not.toContain("Past Root")
    t.destroy()
  })

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

  test("keeps 0-msg compression tips from state.db", async () => {
    const disk = [detail({
      id: "tip", sessionSource: "tui", title: "Compacted tip",
      message_count: 0, started_at: 1700000000,
      parent_session_id: "root", lineage_root_id: "root",
    })]
    const gw = new MockGateway({ "session.list": () => ({ sessions: [] }) })
    const t = await mountNode(<Sessions focused io={{ ...NOIO, list: () => disk }} />, { gw })
    await until(t, () => t.frame().includes("Sessions (1)") && t.frame().includes("Compacted tip"))
    expect(t.frame()).toContain("0")
    t.destroy()
  })

  test("sort: defaults to last-activity; S toggles to started and persists", async () => {
    prefs.reset()
    // "Older Start Fresh Activity" should top "active" sort;
    // "Newer Start Idle" should top "started" sort.
    const DISK = [
      detail({ id: "older-fresh", sessionSource: "tui",
        title: "Older Start Fresh Activity", message_count: 5,
        started_at: 1700000000, last_active: 1700099999 }),
      detail({ id: "newer-idle", sessionSource: "tui",
        title: "Newer Start Idle", message_count: 3,
        started_at: 1700050000, last_active: 1700050001 }),
    ]
    // Gateway reports the same ids (typical local case). Guards the
    // bug scubamount caught: the post-merge re-sort used started_at
    // and clobbered roots()'s order.
    const GW = [
      { id: "older-fresh", title: "Older Start Fresh Activity", preview: "ping",
        message_count: 5, started_at: 1700000000, source: "tui" },
      { id: "newer-idle", title: "Newer Start Idle", preview: "",
        message_count: 3, started_at: 1700050000, source: "tui" },
    ]
    const io = { ...NOIO, list: () => DISK }
    const gw = new MockGateway({ "session.list": () => ({ sessions: GW }) })
    const t = await mountNode(<Sessions focused io={io} />, { gw })
    await until(t, () => t.frame().includes("Sessions (2)"))

    // List rows are the only lines carrying the ✕ delete glyph;
    // Detail panel also prints the selected title, so filter to the
    // list column before comparing order.
    const order = () => {
      const lines = t.frame().split("\n").filter(l => l.includes("✕"))
      const a = lines.findIndex(l => l.includes("Older Start Fresh Activity"))
      const b = lines.findIndex(l => l.includes("Newer Start Idle"))
      expect(a).toBeGreaterThanOrEqual(0)
      expect(b).toBeGreaterThanOrEqual(0)
      return a < b ? "fresh-first" : "idle-first"
    }

    // default: active
    expect(t.frame()).toContain("Active ▾")
    expect(t.frame()).toContain("sort: active")
    expect(order()).toBe("fresh-first")

    // Space no longer sorts; s toggles → started
    await act(async () => { await t.keys.typeText(" ") })
    await t.settle()
    expect(t.frame()).toContain("Active ▾")
    expect(order()).toBe("fresh-first")

    await act(async () => { await t.keys.typeText("s") })
    await until(t, () => t.frame().includes("Start ▾"))
    expect(t.frame()).toContain("sort: started")
    expect(order()).toBe("idle-first")
    expect(prefs.get("sessions")?.sort).toBe("started")

    // toggle back
    await act(async () => { await t.keys.typeText("s") })
    await until(t, () => t.frame().includes("Active ▾"))
    expect(order()).toBe("fresh-first")
    expect(prefs.get("sessions")?.sort).toBe("active")

    prefs.reset()
    t.destroy()
  })

  test("S keeps sorting history while active sessions are pinned", async () => {
    prefs.reset()
    const disk = [
      detail({ id: "older-fresh", sessionSource: "tui",
        title: "Older Start Fresh Activity", message_count: 5,
        started_at: 1700000000, last_active: 1700099999 }),
      detail({ id: "newer-idle", sessionSource: "tui",
        title: "Newer Start Idle", message_count: 3,
        started_at: 1700050000, last_active: 1700050001 }),
    ]
    const gw = new MockGateway({
      "session.active_list": () => ({ sessions: [
        { id: "live-a", title: "Working live", preview: "do the thing", message_count: 3, started_at: 1700100000, status: "working" },
      ]}),
      "session.list": () => ({ sessions: [
        { id: "older-fresh", title: "Older Start Fresh Activity", preview: "ping", message_count: 5, started_at: 1700000000, source: "tui" },
        { id: "newer-idle", title: "Newer Start Idle", preview: "", message_count: 3, started_at: 1700050000, source: "tui" },
      ]}),
    })
    const t = await mountNode(<Sessions focused io={{ ...NOIO, list: () => disk }} />, { gw })
    await until(t, () => t.frame().includes("Sessions (3)"))

    const order = () => {
      const lines = t.frame().split("\n")
      const live = lines.findIndex(l => l.includes("Working live"))
      const a = lines.findIndex(l => l.includes("Older Start Fresh Activity") && l.includes("TUI"))
      const b = lines.findIndex(l => l.includes("Newer Start Idle") && l.includes("TUI"))
      expect(live).toBeGreaterThanOrEqual(0)
      expect(a).toBeGreaterThan(live)
      expect(b).toBeGreaterThan(live)
      return a < b ? "fresh-first" : "idle-first"
    }

    expect(t.frame()).toContain("sort: active")
    expect(t.frame()).toContain("[S] sort: active")
    expect(t.frame()).not.toContain("mouse")
    expect(order()).toBe("fresh-first")

    await act(async () => { await t.keys.typeText("s") })
    await until(t, () => t.frame().includes("Start ▾"))
    expect(t.frame()).toContain("sort: started")
    expect(order()).toBe("idle-first")
    expect(prefs.get("sessions")?.sort).toBe("started")

    prefs.reset()
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

  test("search failure renders inside the tab", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: ROWS }) })
    const search = async () => { throw new Error("search exploded") }
    const t = await mountNode(<Sessions focused io={{ ...NOIO, search }} />, { gw })
    await until(t, () => t.frame().includes("Sessions (2)"))

    await act(async () => { await t.keys.typeText("/") })
    await t.settle()
    await act(async () => { await t.keys.typeText("needle") })
    await until(t, () => t.frame().includes("search exploded"))
    expect(t.frame()).toContain("Search Results")
    t.destroy()
  })

  test("successful search clears the previous search error", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: ROWS }) })
    const search = async (query: string) => {
      if (query === "needle") throw new Error("old search error")
      return [{ session_id: "fresh", title: "Fresh result", snippet: "ok", role: "user", source: "tui", model: null, started_at: 1 }]
    }
    const t = await mountNode(<Sessions focused io={{ ...NOIO, search }} />, { gw })
    await until(t, () => t.frame().includes("Sessions (2)"))
    await act(async () => { await t.keys.typeText("/") })
    await t.settle()
    await act(async () => { await t.keys.typeText("needle") })
    await until(t, () => t.frame().includes("old search error"))
    await act(async () => { await t.keys.typeText("2") })
    await until(t, () => t.frame().includes("Fresh result"))
    expect(t.frame()).not.toContain("old search error")
    t.destroy()
  })

  test("failed search invalidates previous actionable results", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: ROWS }) })
    const search = async (query: string) => {
      if (query === "ab") throw new Error("new search failed")
      return [{ session_id: "stale", title: "Stale result", snippet: "old", role: "user", source: "tui", model: null, started_at: 1 }]
    }
    let switched = ""
    const t = await mountNode(<Sessions focused io={{ ...NOIO, search }} onSwitch={id => { switched = id }} />, { gw })
    await until(t, () => t.frame().includes("Sessions (2)"))
    await act(async () => { await t.keys.typeText("/") }); await t.settle()
    await act(async () => { await t.keys.typeText("a") })
    await until(t, () => t.frame().includes("Stale result"))
    await act(async () => { await t.keys.typeText("b") })
    await until(t, () => t.frame().includes("new search failed"))
    expect(t.frame()).not.toContain("Stale result")
    act(() => t.keys.pressEnter()); await t.settle()
    expect(switched).toBe("")
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

  test("current session cannot enter local-delete fallback when live listing is unavailable", async () => {
    let local = 0
    const gw = new MockGateway({ "session.list": () => ({ sessions: ROWS }) })
    const t = await mountNode(
      <Sessions focused currentId="sid-a" io={{ ...NOIO, remove: () => (local++, true) }} />,
      { gw },
    )
    await until(t, () => t.frame().includes("Sessions (2)"))
    await act(async () => { await t.keys.typeText("d") })
    await t.settle()
    expect(t.frame()).not.toContain("Delete Session?")
    expect(local).toBe(0)
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

  test("session.delete safety failure does not fall back to direct deletion", async () => {
    const gw = new MockGateway({
      "session.list": () => ({ sessions: ROWS }),
      "session.delete": () => { throw new Error("could not enumerate active sessions") },
    })
    let local = 0
    const t = await mountNode(<Sessions focused io={{ ...NOIO, remove: () => (local++, true) }} />, { gw })
    await until(t, () => t.frame().includes("Sessions (2)"))
    await act(async () => { await t.keys.typeText("d") })
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => t.frame().includes("could not enumerate active sessions"))

    expect(local).toBe(0)
    expect(t.frame()).toContain("Sessions (2)")
    t.destroy()
  })

  test("session.delete timeout fails closed because server outcome is unknown", async () => {
    const gw = new MockGateway({
      "session.list": () => ({ sessions: ROWS }),
      "session.delete": () => { throw new Error("timeout: session.delete") },
    })
    let local = 0
    const t = await mountNode(<Sessions focused io={{ ...NOIO, remove: () => (local++, true) }} />, { gw })
    await until(t, () => t.frame().includes("Sessions (2)"))
    await act(async () => { await t.keys.typeText("d") })
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => t.frame().includes("timeout: session.delete"))
    expect(local).toBe(0)
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
    expect(wide).toMatch(/Title\s+Source\s+Start\s*▾?\s+Active\s*▾?\s+Msgs/)
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
    const hdr = lines.find(l => /Title\s+Source\s+Start\s*▾?\s+Active\s*▾?\s+Msgs/.test(l))!
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
    // Bottom border intact (no content bleeding through it). The
    // HintBar footer renders below the pane row, so find the border row
    // (the last non-empty line that contains box-drawing corners).
    const borderRow = f.split("\n").filter(l => /└─+┘└─+┘/.test(l)).at(-1)
    expect(borderRow).toMatch(/└─+┘└─+┘$/)
    t.destroy()
  })
})

// ─── Tree expansion (herm-gsk.15) ────────────────────────────────────
//
// When a parent row has detail.subagent_count > 0, Space on that
// parent renders each child indented with "└─" and lets arrow keys
// traverse in/out of the child block. Only one parent expands at a
// time; moving to another hides the first until its parent is selected
// again.

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

  test("subagent query failure stays inside the tab error boundary", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT, OTHER] }) })
    const io = {
      ...NOIO,
      list: listWithSubs,
      subagents: async () => { throw new Error("children exploded") },
    }
    const t = await mountNode(<Sessions focused io={io} />, { gw, width: 140, height: 30 })
    await until(t, () => t.frame().includes("children exploded"))
    expect(t.frame()).toContain("Parent with subs")
    t.destroy()
  })

  test("subagent detail reads use bounded concurrency", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => detail({
      id: `parent-${i}`,
      sessionSource: "tui",
      title: `Parent ${i}`,
      message_count: 1,
      subagent_count: 1,
    }))
    let active = 0
    let peak = 0
    let calls = 0
    const io = {
      ...NOIO,
      list: () => rows,
      subagents: async () => {
        calls++
        active++
        peak = Math.max(peak, active)
        await Bun.sleep(5)
        active--
        return []
      },
    }
    const t = await mountNode(<Sessions focused io={io} />)
    await until(t, () => calls === rows.length && active === 0)
    expect(peak).toBeLessThanOrEqual(8)
    t.destroy()
  })

  test("late list results cannot replace a newer refresh", async () => {
    const stale = [detail({ id: "stale", sessionSource: "tui", title: "Stale session", message_count: 2 })]
    const fresh = [detail({ id: "fresh", sessionSource: "tui", title: "Fresh session", message_count: 2 })]
    let release!: () => void
    let calls = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    const list = async () => {
      calls++
      if (calls === 1) { await gate; return stale }
      return fresh
    }
    const gw = new MockGateway({ "session.list": () => ({ sessions: [] }) })
    const t = await mountNode(<Sessions focused io={{ ...NOIO, list }} />, { gw, width: 140 })
    await until(t, () => calls === 1)

    await act(async () => { await t.keys.typeText("r") })
    await until(t, () => t.frame().includes("Fresh session"))
    release()
    await gate
    await t.settle()
    expect(t.frame()).toContain("Fresh session")
    expect(t.frame()).not.toContain("Stale session")
    t.destroy()
  })

  test("wide detail mode expands subagents inline with Space, not in the detail pane", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT, OTHER] }) })
    const calls: string[] = []
    const io = { ...NOIO, list: listWithSubs, subagents: subsFor(calls) }
    const t = await mountNode(<Sessions focused io={io} />, { gw, width: 180, height: 30 })
    await until(t, () => t.frame().includes("Sessions (2)"))

    await until(t, () => calls.includes("pid"))
    await t.settle()
    let f = t.frame()
    expect(f).toContain("▸ Parent with subs")
    expect(f).toContain("⎇ spawned 2 subagents")
    expect(f).not.toContain("Sub sessions")
    expect(f).not.toContain("First subagent")
    expect(f).not.toContain("└─First subagent")
    const row = f.split("\n").findIndex(l => l.includes("▸ Parent with subs"))
    const span = (t.spans() as { lines: Array<{ spans: Array<{ text: string; attributes: number }> }> })
      .lines[row].spans.find(s => s.text.includes("Parent with subs"))!
    expect(span.attributes & TextAttributes.UNDERLINE).toBe(TextAttributes.UNDERLINE)

    await act(async () => { await t.keys.typeText(" ") })
    await until(t, () => t.frame().includes("└─First subagent"))
    f = t.frame()
    expect(f).toContain("└─First subagent")
    expect(f).toContain("└─Second subagent")
    expect(f).not.toContain("Sub sessions")
    expect(f).toContain("Sessions (2)")
    t.destroy()
  })

  test("narrow mode keeps Space-expanded subagents inline and keyboard reachable", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT, OTHER] }) })
    const io = { ...NOIO, list: listWithSubs, subagents: subsFor([]) }
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={io} onSwitch={sid => { switched = sid }} />,
      { gw, width: 110, height: 30 },
    )
    await until(t, () => t.frame().includes("Sessions (2)"))
    expect(t.frame()).not.toContain("First subagent")

    await act(async () => { await t.keys.typeText(" ") })
    await until(t, () => t.frame().includes("First subagent"))

    expect(t.frame()).not.toContain("Session Detail")
    expect(t.frame()).toContain("▸ Parent with subs")
    expect(t.frame()).toContain("└─First subagent")
    expect(t.frame()).toContain("2 subs")

    act(() => t.keys.pressArrow("down"))
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Load session?"))
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(switched).toBe("sub-1")
    t.destroy()
  })

  test("arrow down enters children, arrow up exits", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT, OTHER] }) })
    const io = { ...NOIO, list: listWithSubs, subagents: subsFor([]) }
    const t = await mountNode(<Sessions focused io={io} />, { gw, width: 110, height: 30 })
    await until(t, () => t.frame().includes("Sessions (2)"))
    await act(async () => { await t.keys.typeText(" ") })
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

  test("clicking an inline child switches to that child session", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT, OTHER] }) })
    const io = { ...NOIO, list: listWithSubs, subagents: subsFor([]) }
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={io} onSwitch={sid => { switched = sid }} />,
      { gw, width: 180, height: 30 },
    )
    await until(t, () => t.frame().includes("Sessions (2)"))
    await act(async () => { await t.keys.typeText(" ") })
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

  test("detail panel follows the selected list row", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT, OTHER] }) })
    const io = { ...NOIO, list: listWithSubs, subagents: subsFor([]) }
    const t = await mountNode(<Sessions focused io={io} />, { gw, width: 200, height: 40 })
    await until(t, () => t.frame().includes("Sessions (2)"))

    expect(t.frame()).toContain("Parent with subs")
    act(() => t.keys.pressArrow("down"))
    await t.settle()
    await until(t, () => t.frame().includes("▸ Other parent"))
    const lines = t.frame().split("\n")
    const selected = lines.find(l => l.includes("▸ Other parent"))
    const detail = lines.find(l => l.includes("Other parent") && !l.includes("▸"))
    expect(selected).toBeDefined()
    expect(detail).toBeDefined()
    t.destroy()
  })

  test("moving to a parent with no children shows no expansion", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT, OTHER] }) })
    const io = { ...NOIO, list: listWithSubs, subagents: subsFor([]) }
    const t = await mountNode(<Sessions focused io={io} />, { gw, width: 110, height: 30 })
    await until(t, () => t.frame().includes("Sessions (2)"))
    await act(async () => { await t.keys.typeText(" ") })
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
    const t = await mountNode(<Sessions focused io={io} />, { gw, width: 110, height: 30 })
    await until(t, () => t.frame().includes("Sessions (3)"))
    await act(async () => { await t.keys.typeText(" ") })
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
      { gw, width: 110, height: 30 },
    )
    await until(t, () => t.frame().includes("Sessions (2)"))
    await act(async () => { await t.keys.typeText(" ") })
    await until(t, () => t.frame().includes("First subagent"))

    // Walk down through the children to OTHER, then back up one step.
    for (let i = 0; i < 3; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    expect(t.frame()).toContain("▸ Other parent")
    expect(t.frame()).not.toContain("First subagent")

    act(() => t.keys.pressArrow("up")); await t.settle()
    // Anchor moved to PARENT in the collapsed layout; the Space-armed
    // branch is visible again with sel on the parent — not its last
    // child. Simpler than entering children from below.
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
    expect(t.frame()).not.toContain("Sub sessions")
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

  test("late lineage response cannot replace the selected session", async () => {
    let release!: (info: LineageInfo) => void
    const first = new Promise<LineageInfo>(resolve => { release = resolve })
    const rows = [
      detail({ id: "a", sessionSource: "tui", title: "A", message_count: 1 }),
      detail({ id: "b", sessionSource: "tui", title: "B", message_count: 1 }),
    ]
    const lineage = (id: string) => id === "a" ? first : Promise.resolve({ continuesFrom: { id: "b-root", title: "B root" } })
    const t = await mountNode(<Sessions focused io={{ ...NOIO, list: () => rows, lineage }} />, { width: 200, height: 40 })
    await until(t, () => t.frame().includes("Sessions (2)"))
    act(() => t.keys.pressArrow("down"))
    await until(t, () => t.frame().includes("B root"))

    release({ continuesFrom: { id: "a-root", title: "stale A root" } })
    await first
    await t.settle()
    expect(t.frame()).toContain("B root")
    expect(t.frame()).not.toContain("stale A root")
    t.destroy()
  })

  test("lineage failure stays visible in the detail pane", async () => {
    const rows = [detail({ id: "a", sessionSource: "tui", title: "A", message_count: 1 })]
    const lineage = async () => { throw new Error("lineage unavailable") }
    const t = await mountNode(<Sessions focused io={{ ...NOIO, list: () => rows, lineage }} />, { width: 200, height: 40 })
    await until(t, () => t.frame().includes("lineage unavailable"))
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

  test("late peek response cannot replace the selected session", async () => {
    let release!: (rows: PeekMsg[]) => void
    const first = new Promise<PeekMsg[]>(resolve => { release = resolve })
    const gw = new MockGateway({ "session.list": () => ({ sessions: ROWS }) })
    const peek = (sid: string) => sid === "sid-a" ? first : Promise.resolve([pm("user", "beta content")])
    const t = await mountNode(<Sessions focused io={{ ...NOIO, peek }} />, { gw, width: 200, height: 50 })
    await until(t, () => t.frame().includes("Sessions (2)"))
    act(() => t.keys.pressArrow("down"))
    await until(t, () => t.frame().includes("beta content"))

    release([pm("user", "stale alpha content")])
    await first
    await t.settle()
    expect(t.frame()).toContain("beta content")
    expect(t.frame()).not.toContain("stale alpha content")
    t.destroy()
  })

  test("peek failure stays visible in the detail pane", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: ROWS }) })
    const peek = async () => { throw new Error("transcript unavailable") }
    const t = await mountNode(<Sessions focused io={{ ...NOIO, peek }} />, { gw, width: 200, height: 50 })
    await until(t, () => t.frame().includes("transcript unavailable"))
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

describe("Sessions tab — source filters", () => {
  const disk = [
    detail({ id: "chat", sessionSource: "tui", title: "Human chat",
      message_count: 2, started_at: 1700000100 }),
    detail({ id: "cron-run", sessionSource: "cron", title: "Nightly cron",
      message_count: 5, started_at: 1700000200 }),
  ]

  test("builds exact source tabs from loaded history", async () => {
    const rows = [
      detail({ id: "tui", sessionSource: "tui", title: "TUI chat",
        message_count: 2, started_at: 1700000100 }),
      detail({ id: "discord", sessionSource: "discord", title: "Discord chat",
        message_count: 3, started_at: 1700000200 }),
      detail({ id: "bridge", sessionSource: "custom_bridge", title: "Bridge chat",
        message_count: 4, started_at: 1700000300 }),
      detail({ id: "cron", sessionSource: "cron", title: "Cron job",
        message_count: 5, started_at: 1700000400 }),
    ]
    const gw = new MockGateway({ "session.list": () => ({ sessions: [] }) })
    const t = await mountNode(<Sessions focused io={{ ...NOIO, list: () => rows }} />, { gw, width: 130 })
    await until(t, () => t.frame().includes("Custom Bridge 1"))

    const f = t.frame()
    expect(f).toContain("Conversations 3")
    expect(f).toContain("TUI 1")
    expect(f).toContain("Discord 1")
    expect(f).toContain("Custom Bridge 1")
    expect(f).toContain("Cron 1")
    expect(f).not.toContain("Slack")
    expect(f).not.toContain("Telegram")
    expect(f).toContain("TUI chat")
    expect(f).toContain("Discord chat")
    expect(f).toContain("Bridge chat")
    expect(f).not.toContain("Cron job")
    t.destroy()
  })

  test("scrolls an overflowing source filter row to the selected chip", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => detail({
      id: `source-${i}`, sessionSource: `source_${i.toString().padStart(2, "0")}`,
      title: `Source ${i.toString().padStart(2, "0")} row`, message_count: 1,
      started_at: 1700001000 - i,
    }))
    const gw = new MockGateway({ "session.list": () => ({ sessions: [] }) })
    const t = await mountNode(<Sessions focused io={{ ...NOIO, list: () => rows }} />, { gw, width: 70, height: 24 })
    await until(t, () => t.frame().includes("Source 00 1"))

    for (let i = 0; i < 10; i++) act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("Source 09 1"))
    expect(t.frame()).toContain("Source 09 row")
    t.destroy()
  })

  test("defaults to Conversations and ←/→ switches to Cron", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [] }) })
    const t = await mountNode(<Sessions focused io={{ ...NOIO, list: () => disk }} />, { gw, width: 110 })
    await until(t, () => t.frame().includes("Conversations"))

    expect(t.frame()).toContain("Human chat")
    expect(t.frame()).not.toContain("Nightly cron")
    expect(t.frame()).toContain("Conversations 1")
    expect(t.frame()).toContain("Cron 1")
    expect(t.frame()).toContain("[←→] filter")
    expect(t.frame()).not.toContain("●")
    expect(t.frame()).not.toContain("○")
    expect(t.frame()).not.toContain("── Conversations")

    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("Nightly cron"))
    expect(t.frame()).not.toContain("Human chat")
    expect(t.frame()).not.toContain("Load session?")

    act(() => t.keys.pressArrow("left"))
    await until(t, () => t.frame().includes("Human chat"))
    expect(t.frame()).not.toContain("Nightly cron")
    t.destroy()
  })

  test("active sessions stay above a source-only filter", async () => {
    const gw = new MockGateway({
      "session.active_list": () => ({ sessions: [
        { id: "live", title: "Live work", preview: "", message_count: 1,
          started_at: 1700000300, status: "working" },
      ]}),
      "session.list": () => ({ sessions: [] }),
    })
    const t = await mountNode(<Sessions focused io={{ ...NOIO, list: () => disk.slice(1) }} />, { gw, width: 110 })
    await until(t, () => t.frame().includes("Live work") && t.frame().includes("Cron 1"))

    let lines = t.frame().split("\n")
    expect(lines.findIndex(l => l.includes("Live work")))
      .toBeLessThan(lines.findIndex(l => l.includes("Cron 1")))
    expect(t.frame()).toContain("Active Session")
    expect(t.frame()).not.toContain("── Active Session")
    expect(t.frame()).not.toContain("Conversations")
    expect(t.frame()).not.toContain("No conversations found")

    lines = t.frame().split("\n")
    const live = lines.findIndex(l => l.includes("Live work"))
    const tabs = lines.findIndex(l => l.includes("Cron 1"))
    const cron = lines.findIndex(l => l.includes("Nightly cron"))
    expect(live).toBeGreaterThanOrEqual(0)
    expect(tabs).toBeGreaterThan(live)
    expect(cron).toBeGreaterThan(tabs)
    t.destroy()
  })
})

