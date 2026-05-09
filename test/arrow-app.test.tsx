import { describe, test, expect } from "bun:test"
import { act } from "react"
import { mount, until } from "./harness"

describe("full App: up/down arrow → command history", () => {
  test("up cycles history after send (via keyboard event)", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    // ── Send "alpha" ──────────────────────────────────────────────
    await act(async () => { await t.keys.typeText("alpha") })
    await t.settle()
    act(() => t.keys.pressEnter())
    await t.settle()
    
    // ── Send "beta" ───────────────────────────────────────────────
    await act(async () => { await t.keys.typeText("beta") })
    await t.settle()
    act(() => t.keys.pressEnter())
    await t.settle()
    
    // Input should be empty after send (composer cleared)
    // ── Press UP: should recall "beta" ─────────────────────────────
    act(() => t.keys.pressArrow("up"))
    await t.settle()
    
    // Check the composer input row for "beta"
    const rows = t.frame().split("\n")
    const inputRow = rows.find(l => l.trim().startsWith(">") && l.includes("beta"))
    console.log("After UP, input row:", inputRow ?? "(not found)")
    expect(inputRow).toBeDefined()
    
    // ── Press UP again: should recall "alpha" ───────────────────────
    act(() => t.keys.pressArrow("up"))
    await t.settle()
    const rows2 = t.frame().split("\n")
    const inputRow2 = rows2.find(l => l.trim().startsWith(">") && l.includes("alpha"))
    console.log("After 2nd UP, input row:", inputRow2 ?? "(not found)")
    expect(inputRow2).toBeDefined()
    
    t.destroy()
  })
})
