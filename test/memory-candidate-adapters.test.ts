import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { candidateAdapters, endpointAdapter } from "../src/service/memory-candidate-adapters"
import { enrichPrompt } from "../src/service/memory-context"
import type { Adapter, Source } from "../src/service/memory-router"

const src: Source = { kind: "semantic", name: "agentmemory", read: true, write: false }
const base: Adapter = {
  ...src,
  search: () => [{ id: "b", source: src, title: "Base", content: "baseline memory", confidence: 0.9 }],
}

describe("memory-candidate-adapters", () => {
  test("returns config-missing shadow candidates without live adapters", () => {
    const got = candidateAdapters({ env: {} })

    expect(got.filter(x => x.adapters.length === 0).map(x => x.name)).toEqual([
      "hindsight",
      "mem0",
      "graphiti-zep",
      "cognee",
      "supermemory",
    ])
  })

  test("logs unavailable candidates without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-candidates-"))
    await enrichPrompt("What should we do about Hermes memory?", {
      adapters: [base],
      candidates: candidateAdapters({ env: {} }),
      shadowPath: join(dir, "shadow.jsonl"),
    })

    const row = JSON.parse(readFileSync(join(dir, "shadow.jsonl"), "utf8").trim())
    expect(row.candidates[0].candidate).toMatchObject({
      name: "hindsight",
      status: "stub",
      available: false,
      error: "config-missing",
      injects: 0,
      results: 0,
    })
  })

  test("configured endpoint adapter maps fake endpoint results to read-only memory", async () => {
    const mem = endpointAdapter({
      name: "hindsight",
      url: "http://fake.local/search",
      call: async req => {
        expect(req.url).toBe("http://fake.local/search")
        expect(req.query).toEqual({ query: "Hermes memory", limit: 2 })
        return [{ id: "h1", title: "Hindsight", content: "learned memory", score: 0.42 }]
      },
    })

    expect(await mem.search({ text: "Hermes memory" }, 2)).toMatchObject([{
      id: "hindsight:h1",
      source: { name: "hindsight", kind: "semantic", read: true, write: false },
      title: "Hindsight",
      content: "learned memory",
      confidence: expect.any(Number),
    }])
  })
})
