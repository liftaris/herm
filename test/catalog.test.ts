import { describe, expect, test } from "bun:test"
import { DEFAULTS, inScope, scopesOverlap, type ActionId, type Scope } from "../src/keys/catalog"
import { parse, print } from "../src/keys/chord"
import { conflicts, conflictsWith } from "../src/keys/conflicts"

const ids = Object.keys(DEFAULTS) as ActionId[]
const TABLE = new Map(ids.map(id => [id, parse(DEFAULTS[id].chord)] as const))

describe("catalog", () => {
  test("every chord string parses to ≥1 alternate", () => {
    for (const id of ids) {
      const list = parse(DEFAULTS[id].chord)
      expect(list.length, `${id}: "${DEFAULTS[id].chord}"`).toBeGreaterThan(0)
      for (const c of list) expect(c.name, `${id}: empty key name`).not.toBe("")
    }
  })

  test("DEFAULTS has no conflicts across overlapping scopes", () => {
    // Known-intentional: same chord, mutually-exclusive modes. The
    // dialogOpen gate in useAppKeys means these never fire together —
    // Esc is context-sensitive (close dialog / arm interrupt), not a
    // collision.
    const ALLOW = new Set<string>([
      "session.interrupt|dialog.cancel",
      "app.exit|input.clear",
    ])
    const found = conflicts(TABLE).filter(c =>
      !ALLOW.has(`${c.a}|${c.b}`) && !ALLOW.has(`${c.b}|${c.a}`))
    const msg = found.map(c =>
      `${c.a} [${DEFAULTS[c.a].scope}] ↔ ${c.b} [${DEFAULTS[c.b].scope}] on ${print([c.chord])}`,
    ).join("\n")
    expect(found, msg).toEqual([])
  })

  test("leader entry exists and is a plain modifier chord", () => {
    const l = parse(DEFAULTS.leader.chord)[0]
    expect(l.leader).toBe(false)
    expect(l.name).not.toBe("")
  })

  test("inScope partitions the full set", () => {
    const scopes = [...new Set(ids.map(id => DEFAULTS[id].scope))]
    const total = scopes.reduce((n, s) => n + inScope(s).length, 0)
    expect(total).toBe(ids.length)
  })
})

describe("scopesOverlap", () => {
  test("global overlaps everything", () => {
    for (const s of ["list", "dialog", "composer", "sessions", "agents"] as Scope[])
      expect(scopesOverlap("global", s)).toBe(true)
  })
  test("list overlaps tab scopes, not dialog/composer", () => {
    expect(scopesOverlap("list", "sessions")).toBe(true)
    expect(scopesOverlap("list", "agents")).toBe(true)
    expect(scopesOverlap("list", "dialog")).toBe(false)
    expect(scopesOverlap("list", "composer")).toBe(false)
  })
  test("distinct tab scopes don't overlap; dialog/composer are isolated", () => {
    expect(scopesOverlap("sessions", "agents")).toBe(false)
    expect(scopesOverlap("dialog", "composer")).toBe(false)
    expect(scopesOverlap("dialog", "sessions")).toBe(false)
  })
})

describe("conflicts", () => {
  test("detects a synthetic collision (list ↔ tab)", () => {
    const t = new Map(TABLE)
    t.set("agents.kill", parse("r")) // collides with list.refresh in agents scope
    const found = conflicts(t)
    expect(found.some(c =>
      (c.a === "list.refresh" && c.b === "agents.kill") ||
      (c.a === "agents.kill" && c.b === "list.refresh"))).toBe(true)
  })
  test("does not flag same chord across isolated scopes", () => {
    // dialog.accept=return and input.submit=return and list.activate=return
    // coexist — none of those three scopes overlap each other.
    const f = conflicts(TABLE).filter(c => c.chord.name === "return")
    expect(f).toEqual([])
  })
  test("conflictsWith returns the colliding peers for one id", () => {
    const t = new Map(TABLE)
    t.set("agents.kill", parse("r"))
    expect(conflictsWith(t, "agents.kill")).toContain("list.refresh")
    expect(conflictsWith(t, "list.refresh")).toContain("agents.kill")
    expect(conflictsWith(t, "sessions.rename")).toEqual([])
  })
})
