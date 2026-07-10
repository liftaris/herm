import { describe, test, expect, beforeAll } from "bun:test"
import { act, useEffect } from "react"
import { mountNode, until } from "./harness"
import { openStateDb } from "./fixtures/state-db"
import { analytics, cache } from "../src/service/hermes-analytics"
import { Analytics } from "../src/tabs/Analytics"
import { useDialog } from "../src/ui/dialog"

const AnalyticsWithDialog = () => {
  const dialog = useDialog()
  useEffect(() => dialog.replace(<text>analytics modal</text>), [])
  return <Analytics focused />
}

// ─── fixture ─────────────────────────────────────────────────────────
// preload.ts pointed HERMES_HOME at a sandbox tmpdir before hermes-home
// resolved its module-level path const, so hermesPath("state.db") is
// inside the sandbox. Build a minimal sessions table there.

const now = Math.floor(Date.now() / 1000)

beforeAll(() => {
  const db = openStateDb()
  const ins = db.prepare(
    `INSERT OR REPLACE INTO sessions
       (id, source, model, started_at, message_count, tool_call_count,
        input_tokens, output_tokens, cache_read_tokens,
        estimated_cost_usd, actual_cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  // 2 days ago, model-a, tui
  ins.run("s1", "tui", "model-a", now - 2 * 86400, 10, 3, 1000, 500, 200, 0.05, null)
  // 1 day ago, model-a, tui — has actual cost, prefer it over estimate
  ins.run("s2", "tui", "model-a", now - 1 * 86400, 20, 5, 2000, 1000, 0, 0.10, 0.12)
  // 1 day ago, model-b, discord
  ins.run("s3", "discord", "model-b", now - 1 * 86400, 5, 1, 300, 200, 0, 0.01, null)
  // assistant tool_calls rows for byTool — json_each parses function.name
  const msg = db.prepare(
    `INSERT INTO messages (session_id, role, tool_calls, timestamp) VALUES (?, 'assistant', ?, ?)`,
  )
  const tc = (name: string) =>
    JSON.stringify([{ type: "function", function: { name, arguments: "{}" } }])
  msg.run("s1", tc("terminal"), now - 2 * 86400)
  msg.run("s1", tc("terminal"), now - 2 * 86400)
  msg.run("s2", tc("read_file"), now - 1 * 86400)
  db.close()
})

// ─── analytics() ─────────────────────────────────────────────────────

describe("analytics()", () => {
  test("aggregates totals, per-model, per-day, per-tool, per-source", () => {
    const d = analytics(7)
    expect(d.total.sessions).toBe(3)
    expect(d.total.messages).toBe(35)
    expect(d.total.input).toBe(3300)
    expect(d.total.output).toBe(1700)
    expect(d.total.cache).toBe(200)
    expect(d.total.calls).toBe(9)
    expect(d.total.cost).toBeCloseTo(0.18, 4)

    expect(d.byModel).toHaveLength(2)
    // sorted by in+out desc
    expect(d.byModel[0].model).toBe("model-a")
    expect(d.byModel[0].sessions).toBe(2)
    expect(d.byModel[0].input).toBe(3000)
    expect(d.byModel[0].output).toBe(1500)
    expect(d.byModel[0].cache).toBe(200)
    expect(d.byModel[0].cost).toBeCloseTo(0.17, 4)
    expect(d.byModel[1].model).toBe("model-b")

    // byDay is gap-filled to `days` entries, newest last
    expect(d.byDay).toHaveLength(7)
    expect(d.byDay.at(-1)?.sessions).toBe(0)          // today, no fixture rows
    const nonzero = d.byDay.filter(x => x.sessions > 0)
    expect(nonzero).toHaveLength(2)
    expect(nonzero[0].sessions).toBe(1)               // 2d ago: s1
    expect(nonzero[1].sessions).toBe(2)               // 1d ago: s2+s3
    expect(nonzero[1].cost).toBeCloseTo(0.13, 4)

    expect(d.byTool[0]).toEqual({ name: "terminal", n: 2 })
    expect(d.byTool[1]).toEqual({ name: "read_file", n: 1 })

    expect(d.bySource[0]).toEqual({ name: "tui", n: 2 })
    expect(d.bySource[1]).toEqual({ name: "discord", n: 1 })
  })

  test("days window filters out older rows", () => {
    const d = analytics(1.5)
    expect(d.total.sessions).toBe(2)
    expect(d.total.input + d.total.output).toBe(3500)
  })

  test("returns zeros on missing db", () => {
    expect(analytics(0).total.sessions).toBe(0)
  })
})

// ─── Analytics tab ───────────────────────────────────────────────────

describe("Analytics tab", () => {
  test("query failure renders the raw error instead of rejecting globally", async () => {
    cache.clear()
    const load = () => Promise.reject(new Error("analytics exploded"))
    const t = await mountNode(<Analytics focused load={load} />)
    await until(t, () => t.frame().includes("analytics exploded"))
    expect(t.frame()).not.toContain("aggregating 7d")
    t.destroy()
  })

  test("open dialog owns period keys", async () => {
    cache.clear()
    const t = await mountNode(<AnalyticsWithDialog />)
    await until(t, () => t.frame().includes("analytics modal") && t.frame().includes("Analytics · 7d"))

    await act(async () => { await t.keys.typeText("1") })
    await t.settle()
    expect(t.frame()).toContain("Analytics · 7d")
    expect(t.frame()).toContain("analytics modal")
    t.destroy()
  })

  test("renders title totals, chart, model table, tool/source ranks; period keys", async () => {
    cache.clear()
    const t = await mountNode(<Analytics focused />)
    await until(t, () => t.frame().includes("Analytics · 7d"))

    const f = t.frame()
    expect(f).toContain("3 sess")
    expect(f).toContain("5.0k tok")
    expect(f).toContain("$0.18")
    expect(f).toMatch(/Cost per day.+3\.3k in.+1\.7k out/)
    // model table
    expect(f).toContain("Model")
    expect(f).toContain("model-a")
    expect(f).toContain("model-b")
    // rank panes
    expect(f).toContain("Tools")
    expect(f).toContain("terminal")
    expect(f).toContain("Sources")
    expect(f).toContain("tui")
    // chart: at least one eighth-block glyph somewhere
    expect(f).toMatch(/[▁▂▃▄▅▆▇█]/)

    await act(async () => { await t.keys.typeText("3") })
    await until(t, () => t.frame().includes("Analytics · 30d"))
    await act(async () => { await t.keys.typeText("9") })
    await until(t, () => t.frame().includes("Analytics · 90d"))
    await act(async () => { await t.keys.typeText("1") })
    await until(t, () => t.frame().includes("Analytics · 1d"))
    t.destroy()
  })

  test("renders from cache synchronously; effect refreshes and writes back", async () => {
    cache.clear()
    cache.set(7, {
      total: { sessions: 99, messages: 0, input: 10, output: 0, cache: 0, cost: 9, calls: 0 },
      byModel: [{ model: "STALE", sessions: 1, input: 0, output: 0, cache: 0, cost: 0 }],
      byDay: [{ date: "2026-01-01", sessions: 0, cost: 0 }],
      byTool: [{ name: "CACHED_TOOL", n: 5 }], bySource: [],
    })
    const t = await mountNode(<Analytics focused />)
    // mountNode settle()s twice → effect has run → cache replaced with
    // live fixture (3 sessions), and frame reflects it.
    await until(t, () => t.frame().includes("3 sess"))
    expect(cache.get(7)?.total.sessions).toBe(3)
    expect(cache.get(7)?.byTool[0]?.name).toBe("terminal")
    expect(t.frame()).not.toContain("STALE")

    // r reload clears the entry and re-runs
    cache.set(7, { ...cache.get(7)!, total: { ...cache.get(7)!.total, sessions: 0 } })
    await act(async () => { await t.keys.typeText("r") })
    await until(t, () => cache.get(7)?.total.sessions === 3)
    t.destroy()
    cache.clear()
  })

  test("cold window writes cache after background refresh", async () => {
    cache.clear()
    const t = await mountNode(<Analytics focused />)
    await act(async () => { await t.keys.typeText("3") })
    await until(t, () => t.frame().includes("30d · 3 sess"))
    expect(cache.get(30)?.total.sessions).toBe(3)
    expect(cache.get(30)?.byTool[0]?.name).toBe("terminal")
    t.destroy()
    cache.clear()
  })
})
