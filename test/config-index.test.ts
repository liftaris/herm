import { describe, expect, test } from "bun:test"
import { buildFields, groupOf, rawGroupOf, sections, GROUPS } from "../src/config"
import { SCHEMA, SCHEMA_KEYS } from "../src/config/schema"

describe("config/index", () => {
  test("buildFields with empty user config yields every schema key with set=false", () => {
    const fs = buildFields({})
    expect(fs.length).toBe(SCHEMA_KEYS.length)
    for (const f of fs) {
      expect(f.set, f.key).toBe(false)
      expect(f.value).toEqual(SCHEMA[f.key].default)
    }
  })

  test("user-set leaf flips set=true and overrides value", () => {
    const fs = buildFields({ compression: { threshold: 0.8 } })
    const f = fs.find(x => x.key === "compression.threshold")!
    expect(f.set).toBe(true)
    expect(f.value).toBe(0.8)
    const other = fs.find(x => x.key === "compression.enabled")!
    expect(other.set).toBe(false)
  })

  test("list/dict schema keys classify as readonly", () => {
    const fs = buildFields({})
    expect(fs.find(x => x.key === "terminal.docker_volumes")!.type).toBe("readonly")
    expect(fs.find(x => x.key === "providers")!.type).toBe("readonly")
    expect(fs.find(x => x.key === "agent.max_turns")!.type).toBe("number")
  })

  test("tool progress offers only live TUI modes", () => {
    const f = buildFields({}).find(x => x.key === "display.tool_progress")!
    expect(f.type).toBe("select")
    expect(f.options).toEqual(["off", "new", "all", "verbose"])
    expect(f.options).not.toContain("log")
  })

  test("unknown user key surfaces as an extra field", () => {
    const fs = buildFields({ mystery: { flag: true } })
    const f = fs.find(x => x.key === "mystery.flag")
    expect(f).toBeDefined()
    expect(f!.set).toBe(true)
    expect(f!.type).toBe("boolean")
  })

  test("user dict under a known dict-typed leaf doesn't recurse into children", () => {
    const fs = buildFields({ providers: { openai: { api_key: "x" } } })
    expect(fs.find(x => x.key === "providers.openai.api_key")).toBeUndefined()
    const p = fs.find(x => x.key === "providers")!
    expect(p.type).toBe("readonly")
    expect(p.set).toBe(true)
    expect(p.value).toEqual({ openai: { api_key: "x" } })
  })

  test("GROUPS is stable, starts with general, ≤25 entries after merges", () => {
    expect(GROUPS[0]).toBe("general")
    expect(GROUPS.length).toBeLessThanOrEqual(25)
    expect(new Set(GROUPS).size).toBe(GROUPS.length)
  })

  test("every schema key maps to a group in GROUPS", () => {
    for (const k of SCHEMA_KEYS)
      expect(GROUPS.includes(groupOf(k)), `${k} → ${groupOf(k)}`).toBe(true)
  })

  test("sections: single raw group → one headless chunk", () => {
    const fs = buildFields({}).filter(f => groupOf(f.key) === "logging")
    const s = sections("logging", fs)
    expect(s).toHaveLength(1)
    expect(s[0].head).toBeNull()
    expect(s[0].items).toEqual(fs)
  })

  test("sections: merged group chunks by raw, self-named first, preserves fields", () => {
    const fs = buildFields({}).filter(f => groupOf(f.key) === "terminal")
    const s = sections("terminal", fs)
    expect(s.length).toBeGreaterThan(1)
    expect(s[0].head).toBe("terminal")
    expect(s.some(c => c.head === "code_execution")).toBe(true)
    expect(new Set(s.flatMap(c => c.items.map(f => f.key))))
      .toEqual(new Set(fs.map(f => f.key)))
  })

  test("sections: platforms splits per-platform, alphabetical", () => {
    const fs = buildFields({}).filter(f => groupOf(f.key) === "platforms")
    const s = sections("platforms", fs)
    const heads = s.map(c => c.head)
    expect(heads).toEqual([...heads].sort())
    for (const c of s)
      for (const f of c.items)
        expect(rawGroupOf(f.key)).toBe(c.head!)
  })
})
