import { describe, expect, test } from "bun:test"
import { candidates, candidate, writers } from "../src/service/memory-candidates"

const names = [
  "agentmemory",
  "mnemosyne",
  "gbrain",
  "gbrain-gstack",
  "hermes-lcm",
  "hindsight",
  "mem0",
  "graphiti-zep",
  "cognee",
  "supermemory",
]

describe("memory-candidates", () => {
  test("registers every memory eval candidate", () => {
    expect(names.every(name => candidates.some(c => c.name === name))).toBe(true)
  })

  test("keeps agentmemory as the only automatic writer", () => {
    expect(writers.map(c => c.name)).toEqual(["agentmemory"])
  })

  test("keeps shadow candidates non-authoritative", () => {
    expect(candidates.some(c => c.authority)).toBe(false)
    expect(candidates.filter(c => c.name !== "agentmemory").every(c => !c.writes)).toBe(true)
  })

  test("looks up candidates by name", () => {
    expect(candidate("graphiti-zep")).toMatchObject({ lane: "temporal", status: "stub" })
    expect(candidate("missing")).toBeUndefined()
  })
})
