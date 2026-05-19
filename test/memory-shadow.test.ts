import { describe, expect, test } from "bun:test"
import { summarizeShadow, summaryText } from "../src/service/memory-shadow"

describe("memory-shadow", () => {
  test("scores candidate wins, misses, noise, unavailable, degraded, and latency from JSONL", () => {
    const text = [
      JSON.stringify({
        ts: 1,
        query: "alpha",
        baseline: { injects: 0, results: 0, contextChars: 0, sourceMs: { agentmemory: 20 } },
        candidates: [{ candidate: { name: "gbrain", lane: "workflow", status: "shadow", available: true, injects: 1, results: 2, sourceMs: { gbrain: 45 }, degraded: 0 } }],
      }),
      JSON.stringify({
        ts: 2,
        query: "beta",
        baseline: { injects: 2, results: 3, contextChars: 300, sourceMs: { agentmemory: 30 }, degraded: 1 },
        candidates: [{ candidate: { name: "gbrain", lane: "workflow", status: "shadow", available: true, injects: 0, results: 0, sourceMs: { gbrain: 55 }, degraded: 0 } }],
      }),
      JSON.stringify({
        ts: 3,
        query: "gamma",
        baseline: { injects: 1, results: 1, contextChars: 150, sourceMs: { agentmemory: 25 } },
        candidates: [{ candidate: { name: "gbrain", lane: "workflow", status: "shadow", available: true, injects: 3, results: 4, sourceMs: { gbrain: 65 }, degraded: 2 } }],
      }),
      JSON.stringify({
        ts: 4,
        query: "blocked",
        baseline: { injects: 1, results: 1, sourceMs: { agentmemory: 10 } },
        candidates: [{ candidate: { name: "hindsight", lane: "semantic", status: "stub", available: false, error: "config-missing", injects: 0, results: 0, sourceMs: {}, degraded: 0 } }],
      }),
      "not-json",
      JSON.stringify({ query: "delta", baseline: { injects: 1 }, candidates: [] }),
    ].join("\n")

    expect(summarizeShadow(text)).toEqual({
      runs: 5,
      baseline: { injects: 5, results: 5, avgMs: 21, degraded: 1 },
      candidates: [
        {
          name: "gbrain",
          runs: 3,
          wins: 1,
          misses: 1,
          noise: 1,
          degraded: 2,
          unavailable: 0,
          injects: 4,
          results: 6,
          avgMs: 55,
        },
        {
          name: "hindsight",
          runs: 1,
          wins: 0,
          misses: 1,
          noise: 0,
          degraded: 0,
          unavailable: 1,
          injects: 0,
          results: 0,
          avgMs: 0,
        },
      ],
    })
  })

  test("renders a readable candidate summary", () => {
    const text = summaryText(summarizeShadow(JSON.stringify({
      baseline: { injects: 1, results: 2, degraded: 1, sourceMs: { agentmemory: 18 } },
      candidates: [{ candidate: { name: "gbrain", available: false, injects: 0, results: 0, degraded: 0, sourceMs: {} } }],
    })))

    expect(text).toContain("Memory shadow summary")
    expect(text).toContain("runs: 1")
    expect(text).toContain("baseline injects/results/degraded/avgMs: 1/2/1/18")
    expect(text).toContain("candidate       runs  wins  misses  noise  degraded  unavailable  injects  results  avgMs")
    expect(text).toContain("gbrain")
    expect(text).toContain("1            0        0        0")
  })
})
