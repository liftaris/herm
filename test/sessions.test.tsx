import { describe, test, expect } from "bun:test"
import { act } from "react"
import { BoxRenderable, TextRenderable, type Renderable } from "@opentui/core"
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

type T = Awaited<ReturnType<typeof mountNode>>

const walk = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(walk)]

const text = (t: T, value: string) => {
  const node = walk(t.renderer.root).find((r): r is TextRenderable =>
    r instanceof TextRenderable && r.plainText.includes(value))
  expect(node).toBeDefined()
  return node!
}

const box = (t: T, id: string) => {
  const node = t.renderer.root.findDescendantById(id)
  expect(node).toBeInstanceOf(BoxRenderable)
  return node as BoxRenderable
}

const pane = (node: Renderable) => {
  let parent = node.parent
  while (parent && (!(parent instanceof BoxRenderable) || !parent.border)) parent = parent.parent
  expect(parent).toBeInstanceOf(BoxRenderable)
  return parent as BoxRenderable
}

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
  test("pins active sessions above history and activates the live row", async () => {
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
    await until(t, () => t.frame().includes("Working live") && t.frame().includes("First session"))

    const lines = t.frame().split("\n")
    const live = lines.findIndex(l => l.includes("Working live"))
    const hist = lines.findIndex(l => l.includes("First session"))
    expect(live).toBeGreaterThanOrEqual(0)
    expect(hist).toBeGreaterThan(live)
    expect(t.gw.last("session.active_list")?.params.current_session_id).toBe("live-a")

    act(() => t.keys.pressEnter())
    await t.settle()
    expect(activated).toBe("live-a")

    t.destroy()
  })

  test("arrow navigation crosses from active rows into history", async () => {
    const gw = new MockGateway({
      "session.active_list": () => ({ sessions: [
        { id: "live-a", title: "", preview: "", message_count: 3, started_at: 1700000000, status: "working" },
      ]}),
      "session.list": () => ({ sessions: ROWS }),
    })
    const disk = [
      detail({ id: "live-a", sessionSource: "tui", message_count: 3, started_at: 1700000000 }),
    ]
    let switched = ""
    let activated = ""
    const t = await mountNode(
      <Sessions focused io={{ ...NOIO, list: () => disk }}
        onSwitch={sid => { switched = sid }} onActivateLive={sid => { activated = sid }} />,
      { gw, width: 110 },
    )
    await until(t, () => t.frame().includes("First session"))

    act(() => t.keys.pressArrow("down"))
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Load session?"))
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(switched).toBe("sid-a")
    expect(activated).toBe("")

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
    let activated = ""
    const t = await mountNode(
      <Sessions focused io={{ ...NOIO, list: () => disk }} currentId="live-past"
        onActivateLive={sid => { activated = sid }} />,
      { gw, width: 110 },
    )
    await until(t, () => t.frame().includes("Past Root"))

    expect(t.frame().split("\n").filter(line => line.includes("Past Root"))).toHaveLength(1)
    act(() => t.keys.pressEnter())
    await t.settle()
    expect(activated).toBe("live-past")

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

  test("S toggles row ordering and persists the preference", async () => {
    prefs.reset()
    const disk = [
      detail({ id: "older-fresh", sessionSource: "tui",
        title: "Older Start Fresh Activity", message_count: 5,
        started_at: 1700000000, last_active: 1700099999 }),
      detail({ id: "newer-idle", sessionSource: "tui",
        title: "Newer Start Idle", message_count: 3,
        started_at: 1700050000, last_active: 1700050001 }),
    ]
    const rows = [
      { id: "older-fresh", title: "Older Start Fresh Activity", preview: "ping",
        message_count: 5, started_at: 1700000000, source: "tui" },
      { id: "newer-idle", title: "Newer Start Idle", preview: "",
        message_count: 3, started_at: 1700050000, source: "tui" },
    ]
    const gw = new MockGateway({ "session.list": () => ({ sessions: rows }) })
    const t = await mountNode(<Sessions focused io={{ ...NOIO, list: () => disk }} />, { gw, width: 110 })
    await until(t, () => t.frame().includes("Older Start Fresh Activity") && t.frame().includes("Newer Start Idle"))

    const order = () => {
      const lines = t.frame().split("\n")
      return lines.findIndex(line => line.includes("Older Start Fresh Activity"))
        < lines.findIndex(line => line.includes("Newer Start Idle"))
        ? "fresh-first" : "idle-first"
    }

    expect(order()).toBe("fresh-first")
    expect(prefs.get("sessions")?.sort ?? "active").toBe("active")

    await act(async () => { await t.keys.typeText("s") })
    await until(t, () => order() === "idle-first")
    expect(prefs.get("sessions")?.sort).toBe("started")

    await act(async () => { await t.keys.typeText("s") })
    await until(t, () => order() === "fresh-first")
    expect(prefs.get("sessions")?.sort).toBe("active")

    prefs.reset()
    t.destroy()
  })

  test("S sorts history while active sessions stay pinned", async () => {
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
    const t = await mountNode(<Sessions focused io={{ ...NOIO, list: () => disk }} />, { gw, width: 110 })
    await until(t, () => t.frame().includes("Working live") && t.frame().includes("Newer Start Idle"))

    const order = () => {
      const lines = t.frame().split("\n")
      const live = lines.findIndex(line => line.includes("Working live"))
      const fresh = lines.findIndex(line => line.includes("Older Start Fresh Activity"))
      const idle = lines.findIndex(line => line.includes("Newer Start Idle"))
      expect(live).toBeLessThan(fresh)
      expect(live).toBeLessThan(idle)
      return fresh < idle ? "fresh-first" : "idle-first"
    }

    expect(order()).toBe("fresh-first")
    await act(async () => { await t.keys.typeText("s") })
    await until(t, () => order() === "idle-first")
    expect(prefs.get("sessions")?.sort).toBe("started")

    prefs.reset()
    t.destroy()
  })

  test("paints filesystem rows before RPC resolves and merges the result", async () => {
    let unblock!: () => void
    let done = false
    const gate = new Promise<void>(resolve => { unblock = resolve })
    const gw = new MockGateway({
      "session.list": async () => { await gate; done = true; return { sessions: ROWS } },
    })
    const disk = [{
      id: "sid-disk", title: "From disk", lastMessage: "hey", message_count: 3,
      started_at: 1700000000, sessionSource: "cli", subagent_count: 0,
    }]
    const t = await mountNode(
      <Sessions focused io={{ ...NOIO, list: () => disk as never }} />, { gw },
    )

    await until(t, () => t.frame().includes("From disk"))
    expect(done).toBe(false)
    expect(t.frame()).not.toContain("First session")

    unblock()
    await until(t, () => done && t.frame().includes("First session"))
    expect(t.frame()).toContain("From disk")
    t.destroy()
  })

  test("RPC failure preserves the raw error and filesystem fallback", async () => {
    const gw = new MockGateway({
      "session.list": () => { throw new Error("gateway unreachable") },
    })
    const disk = [detail({
      id: "sid-fallback", sessionSource: "cli", title: "Filesystem fallback",
      message_count: 3, started_at: 1700000000,
    })]
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={{ ...NOIO, list: () => disk }} onSwitch={sid => { switched = sid }} />,
      { gw, width: 110 },
    )
    await until(t, () => t.frame().includes("gateway unreachable") && t.frame().includes("Filesystem fallback"))

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Load session?"))
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(switched).toBe("sid-fallback")
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

  test("session.delete local gateway process absence falls back to io.remove", async () => {
    const deleted: string[] = []
    let listed = ROWS
    const gw = new MockGateway({
      "session.list": () => ({ sessions: listed }),
      "session.delete": () => { throw new Error("gateway not running") },
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

  test("session.delete remote gateway disconnect does not enter local fallback", async () => {
    const gw = new MockGateway({
      "session.list": () => ({ sessions: ROWS }),
      "session.delete": () => { throw new Error("gateway not connected") },
    })
    let local = 0
    const t = await mountNode(<Sessions focused io={{ ...NOIO, remove: () => (local++, true) }} />, { gw })
    await until(t, () => t.frame().includes("Sessions (2)"))
    await act(async () => { await t.keys.typeText("d") })
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => t.frame().includes("gateway not connected"))

    expect(local).toBe(0)
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

  test("session.delete ambiguous timeout text does not enter local fallback", async () => {
    const gw = new MockGateway({
      "session.list": () => ({ sessions: ROWS }),
      "session.delete": () => { throw new Error("timeout waiting for Method not found response") },
    })
    let local = 0
    const t = await mountNode(<Sessions focused io={{ ...NOIO, remove: () => (local++, true) }} />, { gw })
    await until(t, () => t.frame().includes("Sessions (2)"))
    await act(async () => { await t.keys.typeText("d") })
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => t.frame().includes("timeout waiting for Method not found response"))
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

  test("title geometry reflows without wrapping or displacing metadata", async () => {
    const long = "A rather long session title that definitely exceeds thirty characters"
    const gw = new MockGateway({
      "session.list": () => ({ sessions: [
        { id: "sid-long", title: long, preview: "", message_count: 7, started_at: 1700000000, source: "tui" },
      ]}),
    })
    const t = await mountNode(<Sessions focused io={NOIO} />, { gw, width: 200, height: 30 })
    await until(t, () => t.frame().includes(long))

    const size = () => {
      const row = box(t, "sess-p-sid-long")
      const cells = row.getChildren().filter((node): node is BoxRenderable => node instanceof BoxRenderable)
      const title = cells[1]
      const source = cells[2]
      const value = walk(title).find((node): node is TextRenderable =>
        node instanceof TextRenderable && node.plainText.includes(long))
      expect(cells).toHaveLength(7)
      expect(value).toBeDefined()
      expect(row.height).toBe(1)
      expect(title.height).toBe(1)
      expect(title.overflow).toBe("hidden")
      expect(title.screenX + title.width).toBe(source.screenX)
      expect(source.width).toBe(9)
      expect(value!.screenY).toBe(row.screenY)
      return { title: title.width, source: source.screenX }
    }

    const wide = size()
    t.resize(110, 30)
    await t.settle()
    await t.settle()
    const narrow = size()

    expect(narrow.title).toBeLessThan(wide.title)
    expect(narrow.source).toBeLessThan(wide.source)
    expect(t.frame().split("\n").filter(line => line.includes("A rather long session title"))).toHaveLength(1)
    t.destroy()
  })

  test("header and data column bounds stay aligned with a visible scrollbar", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `sid-${i}`, title: `Session ${i}`, preview: "",
      message_count: i + 1, started_at: 1700000000 - i * 60, source: "tui",
    }))
    const gw = new MockGateway({ "session.list": () => ({ sessions: many }) })
    const t = await mountNode(<Sessions focused io={NOIO} />, { gw, width: 200, height: 20 })
    await until(t, () => t.frame().includes("Session 0"))

    const row = box(t, "sess-p-sid-0")
    const cells = (node: Renderable) =>
      node.getChildren().filter((child): child is BoxRenderable => child instanceof BoxRenderable)
    const data = cells(row)
    const head = walk(t.renderer.root).find((node): node is BoxRenderable => {
      if (!(node instanceof BoxRenderable) || node === row || node.screenY >= row.screenY) return false
      const cols = cells(node)
      return cols.length === data.length && cols.every((col, i) => col.width === data[i].width)
    })
    expect(head).toBeDefined()
    const headers = cells(head!)
    expect(data).toHaveLength(7)
    expect(headers).toHaveLength(7)

    for (let i = 0; i < 6; i++) {
      expect(headers[i].screenX).toBe(data[i].screenX)
      expect(headers[i].width).toBe(data[i].width)
    }
    expect(headers[5].screenX + headers[5].width).toBe(data[5].screenX + data[5].width)
    t.destroy()
  })

  test("key navigation ignores synthetic hover while real pointer motion still selects", async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      id: `sid-${i}`, title: `Session ${i}`, preview: "",
      message_count: i + 1, started_at: 1700000000 - i * 60, source: "tui",
    }))
    const gw = new MockGateway({ "session.list": () => ({ sessions: many }) })
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={NOIO} onSwitch={sid => { switched = sid }} />,
      { gw, width: 120, height: 20 },
    )
    await until(t, () => t.frame().includes("Session 3"))

    const y = (n: number) => t.frame().split("\n").findIndex(line => line.includes(`Session ${n} `))
    await act(async () => { await t.mouse.moveTo(10, y(3)) })
    await t.settle()

    for (let i = 0; i < 30; i++) act(() => t.keys.pressArrow("down"))
    await t.settle()
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Load session?"))
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(switched).toBe("sid-33")

    await act(async () => { await t.mouse.moveTo(10, y(30)) })
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Load session?"))
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(switched).toBe("sid-30")
    t.destroy()
  })

  test("full-list navigation scrolls and activates End, Home, and PageDown targets", async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      id: `sid-${i}`, title: `Session ${i}`, preview: "",
      message_count: i + 1, started_at: 1700000000 - i * 60, source: "tui",
    }))
    const gw = new MockGateway({ "session.list": () => ({ sessions: many }) })
    const switched: string[] = []
    const t = await mountNode(
      <Sessions focused io={NOIO} onSwitch={sid => { switched.push(sid) }} />,
      { gw, width: 160, height: 30 },
    )
    await until(t, () => t.frame().includes("Session 0"))
    expect(t.gw.last("session.list")?.params.limit).toBe(2000)
    expect(t.frame()).not.toContain("Session 100")

    const activate = async () => {
      act(() => t.keys.pressEnter())
      await until(t, () => t.frame().includes("Load session?"))
      await act(async () => { await t.keys.typeText("y") })
      await t.settle()
    }

    act(() => t.keys.pressKey("END"))
    await t.settle()
    await t.settle()
    expect(t.frame()).toContain("Session 299")
    expect(t.frame()).not.toContain("Session 0 ")
    await activate()
    expect(switched.at(-1)).toBe("sid-299")

    act(() => t.keys.pressKey("HOME"))
    await t.settle()
    await t.settle()
    expect(t.frame()).toContain("Session 0")
    await activate()
    expect(switched.at(-1)).toBe("sid-0")

    act(() => t.keys.pressKey("\x1B[57355u"))
    await t.settle()
    await t.settle()
    await activate()
    const first = Number(switched.at(-1)!.slice(4))
    expect(first).toBeGreaterThan(10)

    act(() => t.keys.pressKey("\x1B[57355u"))
    await t.settle()
    await t.settle()
    expect(t.frame()).not.toContain("Session 0 ")
    await activate()
    expect(Number(switched.at(-1)!.slice(4))).toBe(first * 2)
    t.destroy()
  })

  test("short detail panes keep rendered content within their layout bounds", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: ROWS }) })
    const disk = [
      detail({ id: "sid-a", sessionSource: "tui", title: "First session",
        model: "clip-model-sentinel", message_count: 4, started_at: 1700000000 }),
      detail({ id: "sid-b", sessionSource: "cli", title: "Second session",
        message_count: 12, started_at: 1699999000 }),
    ]
    const t = await mountNode(
      <Sessions focused io={{ ...NOIO, list: () => disk }} />,
      { gw, width: 180, height: 12 },
    )
    await until(t, () => t.frame().includes("clip-model-sentinel"))

    const model = text(t, "clip-model-sentinel")
    const detailPane = pane(model)
    const bottom = detailPane.screenY + detailPane.height
    expect(detailPane.height).toBeGreaterThan(0)
    expect(model.screenY).toBeGreaterThanOrEqual(detailPane.screenY)
    expect(model.screenY + model.height).toBeLessThanOrEqual(bottom)
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

  test("wide mode expands fixture children once inside the list pane", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT, OTHER] }) })
    const calls: string[] = []
    const io = { ...NOIO, list: listWithSubs, subagents: subsFor(calls) }
    const t = await mountNode(<Sessions focused io={io} />, { gw, width: 180, height: 30 })
    await until(t, () => calls.includes("pid"))
    expect(walk(t.renderer.root).filter(node =>
      node instanceof TextRenderable && node.plainText.includes("First subagent"))).toHaveLength(0)

    await act(async () => { await t.keys.typeText(" ") })
    await until(t, () => t.frame().includes("First subagent") && t.frame().includes("Second subagent"))

    const parent = box(t, "sess-p-pid")
    const listPane = pane(parent)
    const first = box(t, "sess-c-sub-1")
    const second = box(t, "sess-c-sub-2")
    for (const child of [first, second]) {
      expect(child.screenX).toBeGreaterThanOrEqual(listPane.screenX)
      expect(child.screenX + child.width).toBeLessThanOrEqual(listPane.screenX + listPane.width)
      expect(child.screenY).toBeGreaterThanOrEqual(listPane.screenY)
      expect(child.screenY + child.height).toBeLessThanOrEqual(listPane.screenY + listPane.height)
    }
    expect(walk(t.renderer.root).filter(node =>
      node instanceof TextRenderable && node.plainText.includes("First subagent"))).toHaveLength(1)
    expect(walk(t.renderer.root).filter(node =>
      node instanceof TextRenderable && node.plainText.includes("Second subagent"))).toHaveLength(1)
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

  test("detail panel replaces the selected row's fixture-owned sentinel", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT, OTHER] }) })
    const list = (): SessionRow[] => [
      detail({ id: "pid", sessionSource: "tui", title: "Parent with subs",
        model: "parent-model-sentinel", message_count: 3, started_at: 1700000000, subagent_count: 2 }),
      detail({ id: "oid", sessionSource: "cli", title: "Other parent",
        model: "other-model-sentinel", message_count: 2, started_at: 1699999000 }),
    ]
    const io = { ...NOIO, list, subagents: subsFor([]) }
    const t = await mountNode(<Sessions focused io={io} />, { gw, width: 200, height: 40 })
    await until(t, () => t.frame().includes("parent-model-sentinel"))

    act(() => t.keys.pressArrow("down"))
    await until(t, () => t.frame().includes("other-model-sentinel"))
    expect(t.frame()).not.toContain("parent-model-sentinel")
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

  test("arrow down past the last child activates the immediate next parent", async () => {
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
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={io} onSwitch={sid => { switched = sid }} />,
      { gw, width: 110, height: 30 },
    )
    await until(t, () => t.frame().includes("Sessions (3)"))
    await act(async () => { await t.keys.typeText(" ") })
    await until(t, () => t.frame().includes("First subagent"))

    // sel=0 (PARENT) → ↓×3 = sub1, sub2, OTHER. Must NOT skip to THIRD.
    for (let i = 0; i < 3; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Load session?"))
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(switched).toBe("oid")
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

  test("compression successor is actionable", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [PARENT_COMP] }) })
    const list = (): SessionRow[] => [
      detail({ id: "rid", sessionSource: "tui", title: "Root", message_count: 5, end_reason: "compression" }),
    ]
    const lineage = () => ({ compressedTo: { id: "tid", title: "Live tip" } })
    const io = { ...NOIO, list, lineage }
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={io} onSwitch={sid => { switched = sid }} />,
      { gw, width: 200, height: 40 },
    )
    await until(t, () => t.frame().includes("Live tip"))

    const lines = t.frame().split("\n")
    const y = lines.findIndex(line => line.includes("Live tip"))
    const x = lines[y].indexOf("Live tip")
    await act(async () => { await t.mouse.pressDown(x, y) })
    await until(t, () => t.frame().includes("Load session?"))
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(switched).toBe("tid")
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
  test("user and assistant transcript rows keep opposite-side gutter geometry", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: ROWS }) })
    const peek = (sid: string): PeekMsg[] => sid === "sid-a" ? [
      pm("user", "please fix the parser"),
      pm("assistant", null, { tool_calls: '[{"name":"read_file"}]' }),
      pm("tool", "file content", { tool_name: "read_file" }),
      pm("assistant", "Found it — missing brace on line 42."),
    ] : []
    const t = await mountNode(<Sessions focused io={{ ...NOIO, peek }} />, { gw, width: 200, height: 50 })
    await until(t, () => t.frame().includes("please fix the parser") && t.frame().includes("missing brace"))

    const user = text(t, "please fix the parser")
    const assistant = text(t, "missing brace on line 42")
    const transcript = pane(user)
    const userRow = user.parent?.parent
    const assistantRow = assistant.parent?.parent
    expect(userRow).toBeInstanceOf(BoxRenderable)
    expect(assistantRow).toBeInstanceOf(BoxRenderable)
    expect(user.screenX).toBeGreaterThan(userRow!.screenX)
    expect(assistant.screenX).toBe(assistantRow!.screenX)
    expect(userRow!.screenX).toBeGreaterThan(transcript.screenX)
    expect(assistantRow!.screenX + assistantRow!.width)
      .toBeLessThan(transcript.screenX + transcript.width)
    expect(user.screenY).toBe(userRow!.screenY)
    expect(assistant.screenY).toBe(assistantRow!.screenY)
    t.destroy()
  })

  test("peek re-queries and removes the previous transcript on selection change", async () => {
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
    await until(t, () => calls.includes("sid-b") && !t.frame().includes("alpha content here"))
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


})

describe("Sessions tab — source filters", () => {
  const disk = [
    detail({ id: "chat", sessionSource: "tui", title: "Human chat",
      message_count: 2, started_at: 1700000100 }),
    detail({ id: "cron-run", sessionSource: "cron", title: "Nightly cron",
      message_count: 5, started_at: 1700000200 }),
  ]

  test("source filters cycle through aggregate and fixture-owned rows", async () => {
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
    await until(t, () => t.frame().includes("TUI chat") && t.frame().includes("Bridge chat"))

    const visible = (yes: string[], no: string[]) => {
      for (const value of yes) expect(t.frame()).toContain(value)
      for (const value of no) expect(t.frame()).not.toContain(value)
    }
    visible(["TUI chat", "Discord chat", "Bridge chat"], ["Cron job"])

    const titles = ["TUI chat", "Discord chat", "Bridge chat", "Cron job"]
    const seen = new Set<string>()
    for (let i = 0; i < titles.length; i++) {
      act(() => t.keys.pressArrow("right"))
      await until(t, () => titles.filter(title => t.frame().includes(title)).length === 1)
      seen.add(titles.find(title => t.frame().includes(title))!)
    }
    expect(seen).toEqual(new Set(titles))
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

  test("arrow filters switch fixture rows without activating a session", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [] }) })
    let switched = ""
    const t = await mountNode(
      <Sessions focused io={{ ...NOIO, list: () => disk }} onSwitch={sid => { switched = sid }} />,
      { gw, width: 110 },
    )
    await until(t, () => t.frame().includes("Human chat"))

    expect(t.frame()).toContain("Human chat")
    expect(t.frame()).not.toContain("Nightly cron")

    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("Nightly cron"))
    expect(t.frame()).not.toContain("Human chat")
    expect(switched).toBe("")

    act(() => t.keys.pressArrow("left"))
    await until(t, () => t.frame().includes("Human chat"))
    expect(t.frame()).not.toContain("Nightly cron")
    expect(switched).toBe("")
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

