import { describe, test, expect, beforeEach } from "bun:test"
import { act } from "react"
import { mkdirSync, writeFileSync } from "node:fs"
import { mountNode, until } from "./harness"
import { ENV_CATALOG, hermesPath } from "../src/service/hermes-home"
import { Env } from "../src/tabs/Env"

// hermes-home resolves ENV_PATH at import time from the sandbox
// HERMES_HOME set in preload.ts — write the fixture there.
const ENV = hermesPath(".env")

beforeEach(() => {
  mkdirSync(hermesPath("."), { recursive: true })
  writeFileSync(ENV, "ANTHROPIC_API_KEY=«redacted:sk-…»\nCUSTOM_THING=hello\n")
})

describe("Env tab", () => {
  test("catalog includes Vertex credentials with provider keys", () => {
    const group = ENV_CATALOG.find(g => g.category === "LLM Providers")
    const all = ENV_CATALOG.flatMap(g => g.keys)
    const dupes = all.filter((k, i, a) => a.indexOf(k) !== i)

    expect(group?.keys).toContain("VERTEX_CREDENTIALS_PATH")
    expect(all).toContain("VERTEX_CREDENTIALS_PATH")
    expect(dupes).toEqual([])
  })

  test("masks values by default; Space reveals all", async () => {
    const t = await mountNode(<Env focused />, { height: 90 })
    await until(t, () => t.frame().includes("ANTHROPIC_API_KEY"))

    const f = t.frame()
    expect(f).toContain("SET")
    expect(f).toContain("•".repeat(12))
    expect(f).not.toContain("sk-ant-" + "secret123")
    // Un-catalogued key surfaces under Other
    expect(f).toContain("Other")
    expect(f).toContain("CUSTOM_THING")
    expect(f).not.toContain("hello")

    await act(async () => { await t.keys.typeText(" ") })
    await until(t, () => t.frame().includes("hello"))
    expect(t.frame()).toContain("hello")

    // Toggle back
    await act(async () => { await t.keys.typeText(" ") })
    await until(t, () => !t.frame().includes("hello"))
    t.destroy()
  })

  test("Enter reveals selected, second Enter opens edit prompt", async () => {
    const t = await mountNode(<Env focused />)
    await until(t, () => t.frame().includes("ANTHROPIC_API_KEY"))

    // row 0 is the "LLM Providers" header → move to first var
    act(() => t.keys.pressArrow("down"))
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("«redacted:sk-…»"))

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Edit ANTHROPIC_API_KEY"))
    act(() => t.keys.pressEscape())
    await t.settle()
    t.destroy()
  })

  test("click row reveals; second click opens edit; click header collapses", async () => {
    const SECRET = "«redacted:sk-…»"
    const t = await mountNode(<Env focused />, { width: 120, height: 40 })
    await until(t, () => t.frame().includes("ANTHROPIC_API_KEY"))

    const rowY = (s: string) => t.frame().split("\n").findIndex(l => l.includes(s))
    const tap = async (s: string) => {
      const y = rowY(s)
      await act(async () => { await t.mouse.pressDown(30, y) })
      await t.settle()
      await act(async () => { await t.mouse.release(30, y) })
      await t.settle()
    }
    // Click a set var → reveals value (Enter-parity path 1).
    expect(t.frame()).not.toContain(SECRET)
    await tap("ANTHROPIC_API_KEY")
    await until(t, () => t.frame().includes(SECRET))
    // Second click → edit prompt (Enter-parity path 2).
    await tap("ANTHROPIC_API_KEY")
    await until(t, () => t.frame().includes("Edit ANTHROPIC_API_KEY"))
    act(() => t.keys.pressEscape())
    await t.settle()
    // Click header → collapses group.
    await tap("LLM Providers")
    expect(t.frame()).not.toContain("ANTHROPIC_API_KEY")
    t.destroy()
  })

  test("n prompts for key then value and writes to .env", async () => {
    const t = await mountNode(<Env focused />)
    await until(t, () => t.frame().includes("ANTHROPIC_API_KEY"))

    await act(async () => { await t.keys.typeText("n") })
    await until(t, () => t.frame().includes("New Variable"))
    for (const c of "FOO_KEY") await act(async () => { await t.keys.typeText(c) })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Set FOO_KEY"))
    for (const c of "abc") await act(async () => { await t.keys.typeText(c) })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("FOO_KEY added"))

    const text = await Bun.file(ENV).text()
    expect(text).toContain("FOO_KEY=abc")
    t.destroy()
  })

  test("cataloged Vertex credentials do not surface as Other", async () => {
    writeFileSync(ENV, "VERTEX_CREDENTIALS_PATH=/tmp/vertex.json\nCUSTOM_THING=hello\n")
    const t = await mountNode(<Env focused />, { height: 90 })
    await until(t, () => t.frame().includes("VERTEX_CREDENTIALS_PATH"))

    const lines = t.frame().split("\n")
    const providers = lines.findIndex(l => l.includes("LLM Providers"))
    const vertex = lines.findIndex(l => l.includes("VERTEX_CREDENTIALS_PATH"))
    const other = lines.findIndex(l => l.includes("Other"))
    expect(providers).toBeGreaterThanOrEqual(0)
    expect(vertex).toBeGreaterThan(providers)
    expect(other).toBeGreaterThan(vertex)
    expect(t.frame()).toContain("CUSTOM_THING")
    t.destroy()
  })
})
