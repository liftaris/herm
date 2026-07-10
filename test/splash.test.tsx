import { describe, test, expect, afterAll } from "bun:test"
import { act } from "react"
import { mount, until } from "./harness"
import { openStateDb } from "./fixtures/state-db"
import { resetDb } from "../src/service/sessions-db"
import { loadTips, splitTip } from "../src/service/tips"

// Sentinel for "splash frame is painted". Must be splash-unique because the
// sidebar avatar also renders braille — can't key on /[⠁-⣿]/ anymore.
// TL corner, row 2 of the baked 9-patch (src/ui/splash-art.ts).
const SPLASH = "⠀⢸⡖⢿⠏⣤⣶⣽⣫⢶⣢⡌⠹⣧⡏⠻"
const splashUp = (f: string) => f.includes(SPLASH)

const seed = (last?: { id: string; title: string }) => {
  const db = openStateDb()
  db.run("DELETE FROM messages"); db.run("DELETE FROM sessions")
  if (last) db.prepare(
    "INSERT INTO sessions (id, title, source, started_at, message_count) VALUES (?,?,?,?,?)",
  ).run(last.id, last.title, "tui", 1000, 3)
  db.close()
  resetDb()
}

describe("splash (herm-tji.2)", () => {
  afterAll(() => seed())

  test("mode:new → splash renders frame + wordmark; composer is live", async () => {
    seed()
    const t = await mount({ launch: { mode: "new", splash: true } })
    await until(t, () => t.frame().includes("HERM") || splashUp(t.frame()))
    expect(splashUp(t.frame())).toBe(true)       // braille frame
    expect(t.frame()).toMatch(/v\d+\.\d+\.\d+/)       // sub-line
    expect(t.frame()).toContain("Ready")              // composer still live
    expect(t.frame()).not.toContain("continue \"")     // no lastReal
    t.destroy()
  })

  test("upstream no-count sentinel is not shown as a negative behind count", async () => {
    seed()
    const t = await mount({
      launch: { mode: "new", splash: true },
      handlers: { "session.create": () => ({ session_id: "test-sid", info: { update_behind: -1 } }) },
    })
    await until(t, () => splashUp(t.frame()))
    expect(t.frame()).not.toContain("-1 behind")
    expect(t.frame()).not.toContain("-1 commits behind")
    t.destroy()
  })

  test("zero and positive behind counts stay visible", async () => {
    seed()
    const t = await mount({
      launch: { mode: "new", splash: true },
      handlers: { "session.create": () => ({ session_id: "test-sid", info: { update_behind: 0 } }) },
    })
    await until(t, () => t.frame().includes("up to date"))
    expect(t.frame()).toContain("up to date")
    t.destroy()

    seed()
    const u = await mount({
      launch: { mode: "new", splash: true },
      handlers: { "session.create": () => ({ session_id: "test-sid", info: { update_behind: 3 } }) },
    })
    await until(u, () => u.frame().includes("3 behind"))
    expect(u.frame()).toContain("3 behind")
    u.destroy()
  })

  test("tip pinned at bottom of inner window; click cycles", async () => {
    seed()
    const t = await mount({ launch: { mode: "new", splash: true } })
    await until(t, () => splashUp(t.frame()))
    // Rendered form (splitTip strips backticks from code spans).
    const tips = loadTips().map(s => splitTip(s).map(p => p.t).join(""))
    const rows = t.frame().split("\n")
    const tipRow = rows.findIndex(l => tips.some(tp => l.includes(tp)))
    expect(tipRow).toBeGreaterThan(-1)
    // Below the centered prompt, above the B-border band — i.e. bottom
    // of the inner window, not floating mid-column.
    const promptRow = rows.findIndex(l => l.includes("[enter]"))
    const bTop = rows.findIndex(l => l.includes("⡿⣻⣖"))  // B[0] sentinel
    expect(tipRow).toBeGreaterThan(promptRow)
    expect(tipRow).toBe(bTop - 1)

    // Click the tip text → cycles to a different tip.
    const before = rows[tipRow]
    const hit = tips.find(tp => before.includes(tp))!
    await act(async () => { await t.mouse.pressDown(before.indexOf(hit) + 2, tipRow) })
    await until(t, () => t.frame().split("\n")[tipRow] !== before)
    expect(tips.some(tp => t.frame().includes(tp))).toBe(true)
    t.destroy()
  })

  test("short terminal → tip suppressed (inner.h < 14)", async () => {
    seed()
    // h=28 → content region ≈23 → inner.h = 23 - 2*ch = 7 < 14
    const t = await mount({ launch: { mode: "new", splash: true }, height: 28 })
    await until(t, () => splashUp(t.frame()))
    expect(loadTips().some(tp => t.frame().includes(tp))).toBe(false)
    t.destroy()
  })

  test("first send dismisses; prompt.submit fires", async () => {
    seed()
    const t = await mount({ launch: { mode: "new", splash: true } })
    await until(t, () => splashUp(t.frame()))
    await act(async () => { await t.keys.typeText("hello") })
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => !splashUp(t.frame()))
    expect(t.gw.last("prompt.submit")?.params.text).toBe("hello")
    t.destroy()
  })

  test("lastReal present → continue-prompt; empty-Enter resumes", async () => {
    seed({ id: "prev-sid", title: "fix the latex bug" })
    const t = await mount({ launch: { mode: "new", splash: true } })
    await until(t, () => t.frame().includes("fix the latex bug"))
    expect(t.frame()).toContain("[enter]")
    act(() => t.keys.pressEnter())
    await until(t, () => !splashUp(t.frame()))
    expect(t.gw.last("session.resume")?.params.session_id).toBe("prev-sid")
    expect(t.gw.calls.some(c => c.method === "prompt.submit")).toBe(false)
    t.destroy()
  })

  test("typing hides continue-prompt (doesn't dismiss splash)", async () => {
    seed({ id: "prev-sid", title: "fix the latex bug" })
    const t = await mount({ launch: { mode: "new", splash: true } })
    await until(t, () => t.frame().includes("fix the latex bug"))
    await act(async () => { await t.keys.typeText("h") })
    await t.settle()
    expect(t.frame()).not.toContain("fix the latex bug")
    expect(splashUp(t.frame())).toBe(true)        // splash still up
    t.destroy()
  })

  test("mode:resume → splash shows Loading… frame (not the empty-chat welcome)", async () => {
    seed({ id: "prev-sid", title: "x" })
    const t = await mount({ launch: { mode: "resume" } })
    await until(t, () => t.frame().includes("Ready"))
    // Braille frame painted — the splash is up.
    expect(splashUp(t.frame())).toBe(true)
    t.destroy()
  })

  test("mode:resume + --no-splash → no splash", async () => {
    seed({ id: "prev-sid", title: "x" })
    const t = await mount({ launch: { mode: "resume", splash: false } })
    await until(t, () => t.frame().includes("Ready"))
    expect(splashUp(t.frame())).toBe(false)
    // Old MessageList welcome is gone — empty transcript is just blank.
    expect(t.frame()).not.toContain("H E R M")
    expect(t.frame()).not.toContain("Type a message below")
    t.destroy()
  })

  test("/new re-raises the braille frame (not the old welcome)", async () => {
    seed()
    const t = await mount({ launch: { mode: "new", splash: true } })
    await until(t, () => splashUp(t.frame()))
    // Dismiss via first send.
    await act(async () => { await t.keys.typeText("hi") })
    act(() => t.keys.pressEnter())
    await until(t, () => !splashUp(t.frame()))
    act(() => t.gw.push({ type: "message.start" }))
    act(() => t.gw.push({ type: "message.complete", payload: { text: "ok" } }))
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/new now") })
    act(() => t.keys.pressEnter())
    await until(t, () => splashUp(t.frame()))
    expect(t.frame()).not.toContain("H E R M")
    // summoned: no continue-prompt, Esc dismisses.
    expect(t.frame()).not.toContain("continue \"")
    act(() => t.keys.pressEscape())
    await until(t, () => !splashUp(t.frame()))
    t.destroy()
  })
})
