import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { evaluateMemoryFixtures, fixtureAdapters, reportText, type Fixture } from "../src/service/memory-eval"
import type { Adapter, Result, Source } from "../src/service/memory-router"

const cases = JSON.parse(readFileSync("test/fixtures/memory-eval-prompts.json", "utf8")) as Fixture[]

const src = {
  semantic: { kind: "semantic", name: "agentmemory", read: true, write: true },
  repo: { kind: "repo", name: "repo", read: true, write: false },
  vault: { kind: "vault", name: "obsidian", read: true, write: false },
} satisfies Record<string, Source>

const hit = (id: string, source: Source, content: string, confidence = 0.92): Result => ({
  id,
  source,
  title: id,
  content,
  confidence,
})

const terms = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? [])

const mem: Adapter[] = [
  {
    ...src.semantic,
    search: query => {
      const q = terms(query.text)
      return [
        hit("arch", src.semantic, "Hermes router stays baseline and agentmemory remains the only semantic writer."),
        hit("closeout", src.semantic, "Cody closeouts update memory and skills only on signal."),
        hit("riley", src.semantic, "Paperclip owns Rally ops while Hermes owns routing and memory authority."),
        hit("imessage", src.semantic, "For iMessage simple lookups use the fastest reliable path and reply in one finished bubble."),
        hit("life", src.semantic, "Agent tool evaluations must include lifestyle capabilities like dinner reservations and travel."),
        hit("truncated", src.semantic, "Price flags ~5 minute iMessage response times:", 0.62),
      ].filter(x => Array.from(terms(`${x.title} ${x.content}`)).some(w => q.has(w)))
    },
  },
  {
    ...src.repo,
    search: query => query.text.includes("config") ? [hit("repo-config", src.repo, "Obsidian is authority; repo config is current truth for memory settings.")] : [],
  },
  {
    ...src.vault,
    search: query => query.text.includes("config") ? [hit("vault-config", src.vault, "Obsidian is authority over semantic hints.")] : [],
  },
]

describe("memory eval fixtures", () => {
  test("fixture file covers required categories", () => {
    expect(cases.map(x => x.category)).toEqual([
      "memory architecture decisions",
      "Obsidian authority vs semantic hints",
      "closeout behavior",
      "Riley/Paperclip/Hermes routing",
      "stale/truncated memory traps",
      "iMessage/simple lookup speed preference",
      "lifestyle tooling inclusion",
      "reference-only memory-context safety",
    ])
  })

  test("runs deterministic baseline eval without external services", async () => {
    const report = await evaluateMemoryFixtures(cases as Fixture[], { adapters: mem, shadowPath: false })

    expect(report.total).toBe(cases.length)
    expect(report.failed).toEqual([])
    expect(report.results.find(x => x.id === "reference-only-safety")?.skipped).toBe(true)
    expect(report.results.find(x => x.id === "stale-truncated-trap")?.degraded).toBeGreaterThan(0)
    expect(report.results.find(x => x.id === "obsidian-authority-over-semantic")?.sources.slice(0, 2)).toEqual(["repo", "obsidian"])
    expect(report.summary.runs).toBe(cases.length)
  })

  test("ships default fixture adapters and report text for local eval runs", async () => {
    const report = await evaluateMemoryFixtures(cases as Fixture[], { adapters: fixtureAdapters(), shadowPath: false })
    const text = reportText(report)

    expect(report.failed).toEqual([])
    expect(text).toContain(`Memory eval: ${cases.length}/${cases.length} passed`)
    expect(text).toContain("reference-only-safety")
    expect(text).toContain("stale-truncated-trap")
    expect(text).toContain("Memory shadow summary")
  })
})
