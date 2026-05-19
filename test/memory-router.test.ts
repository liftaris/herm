import { describe, expect, test } from "bun:test"
import {
  canInject,
  canWrite,
  explain,
  fromSessions,
  fromVault,
  inject,
  intentOf,
  rank,
  recall,
  recallPacket,
  formatMemoryContext,
  type Result,
  type Source,
} from "../src/service/memory-router"

const src: Source[] = [
  { kind: "semantic", name: "agentmemory", read: true, write: true },
  { kind: "local", name: "mnemosyne", read: true, write: false },
  { kind: "session", name: "session_search", read: true, write: false },
  { kind: "vault", name: "obsidian", read: true, write: false },
  { kind: "repo", name: "repo", read: true, write: false },
  { kind: "skill", name: "skills", read: true, write: false },
  { kind: "hot", name: "profile", read: true, write: false },
]

const res = (part: Partial<Result> = {}): Result => ({
  id: "r1",
  source: src[0],
  title: "Memory",
  content: "content",
  confidence: 0.9,
  ...part,
})

describe("memory-router", () => {
  test("classifies common query intents", () => {
    expect(intentOf("What does Price prefer for reminders?")).toBe("preference")
    expect(intentOf("What did we do last time on Hermes?")).toBe("history")
    expect(intentOf("Find the source article in Obsidian")).toBe("source")
    expect(intentOf("How do we publish the newsletter?")).toBe("procedure")
    expect(intentOf("What is the current config setting?")).toBe("truth")
    expect(intentOf("Use Mnemosyne for this project scoped recall")).toBe("local")
    expect(intentOf("Have we solved this before?")).toBe("pattern")
  })

  test("ranks authoritative sources first for current truth", () => {
    expect(rank(src, { text: "what is true now in config" }).map(s => s.name).slice(0, 3))
      .toEqual(["repo", "obsidian", "profile"])
  })

  test("keeps agentmemory ahead for broad semantic patterns", () => {
    expect(rank(src, { text: "have we solved this before" }).map(s => s.name).slice(0, 2))
      .toEqual(["agentmemory", "session_search"])
  })

  test("uses Mnemosyne only for explicit local scoped recall", () => {
    expect(rank(src, { text: "this project scoped Mnemosyne recall" }).map(s => s.name).slice(0, 2))
      .toEqual(["mnemosyne", "agentmemory"])
  })

  test("allows only the write owner to auto-write", () => {
    expect(canWrite(src[0], "agentmemory")).toBe(true)
    expect(canWrite({ ...src[1], write: true }, "agentmemory")).toBe(false)
  })

  test("blocks low confidence, stale, deprecated, and degraded prompt injection", () => {
    expect(canInject(res())).toBe(true)
    expect(canInject(res({ confidence: 0.4 }))).toBe(false)
    expect(canInject(res({ stale: true }))).toBe(false)
    expect(canInject(res({ deprecated: true }))).toBe(false)
    expect(canInject(res({ degraded: true }))).toBe(false)
  })

  test("marks visibly truncated session recall as degraded", async () => {
    const mem = fromSessions(() => [{
      session_id: "s1",
      title: "Compacted context",
      snippet: "Price flags iMessage response times:",
      role: "assistant",
      source: "cli",
      model: "gpt",
      started_at: 10,
    }])
    const packet = await recallPacket([mem], { text: "what did Price say last time about iMessage response times" })

    expect(packet.results[0].degraded).toBe(true)
    expect(packet.injects).toHaveLength(0)
    expect(packet.trace.dropped).toContainEqual({
      id: packet.results[0].id,
      source: "session_search",
      reason: "degraded",
    })
  })

  test("explains provenance for injectable results", () => {
    const [item] = inject([res({ file: "context/cody/current-state.md" })])
    expect(item.reason).toContain("agentmemory/semantic")
    expect(item.reason).toContain("context/cody/current-state.md")
    expect(explain(res({ sessionId: "s1", stale: true }))).toContain("stale")
  })

  test("maps session hits into read-only provenance results", async () => {
    const mem = fromSessions(() => [{
      session_id: "s1",
      title: "Memory router work",
      snippet: ">>>agentmemory<<< router notes",
      role: "assistant",
      source: "cli",
      model: "gpt",
      started_at: 10,
    }])
    const [item] = await mem.search({ text: "agentmemory router" })
    expect(mem.write).toBe(false)
    expect(item.source.name).toBe("session_search")
    expect(item.sessionId).toBe("s1")
    expect(item.content).toBe("agentmemory router notes")
    expect(explain(item)).toContain("s1")
  })

  test("searches vault docs as authoritative source results", async () => {
    const mem = fromVault([
      { file: "context/cody/noise.md", content: "unrelated" },
      { file: "context/cody/memory.md", content: "agentmemory is pilot, Mnemosyne is sandboxed", updatedAt: 20 },
    ])
    const [item] = await mem.search({ text: "Mnemosyne sandboxed" })
    expect(mem.write).toBe(false)
    expect(item.source.kind).toBe("vault")
    expect(item.file).toBe("context/cody/memory.md")
    expect(item.confidence).toBeGreaterThan(0.7)
  })

  test("recalls from ranked read-only adapters and dedupes results", async () => {
    const calls: string[] = []
    const sem = {
      ...src[0],
      search: () => {
        calls.push("agentmemory")
        return [res({ id: "same", source: src[0], confidence: 0.9 })]
      },
    }
    const sess = fromSessions(() => {
      calls.push("session_search")
      return [{
        session_id: "same",
        title: "Earlier work",
        snippet: "same memory",
        role: "assistant",
        source: "cli",
        model: null,
        started_at: 1,
      }]
    })
    const got = await recall([sem, sess], { text: "what did we do last time" })
    expect(calls).toEqual(["session_search", "agentmemory"])
    expect(got.map(r => r.source.name)).toEqual(["session_search", "agentmemory"])
    expect(got.every(r => r.source.write === false || r.source.name === "agentmemory")).toBe(true)
  })

  test("recallPacket isolates slow and failing adapters with trace drops", async () => {
    const fast = { ...src[0], search: () => [res({ id: "fast", source: src[0] })] }
    const slow = { ...src[2], search: () => new Promise<Result[]>(resolve => setTimeout(() => resolve([res({ id: "slow", source: src[2] })]), 30)) }
    const fail = { ...src[3], search: () => { throw new Error("boom") } }
    const packet = await recallPacket([slow, fail, fast], { text: "have we solved this before" }, { timeoutMs: 5 })
    expect(packet.results.map(r => r.id)).toEqual(["fast"])
    expect(packet.trace.dropped.some(x => x.source === "session_search" && x.reason === "timeout")).toBe(true)
    expect(packet.trace.dropped.some(x => x.source === "obsidian" && x.reason === "error")).toBe(true)
  })

  test("recallPacket dedupes by canonical provenance and keeps authoritative newer result", async () => {
    const repo = { ...src[4], search: () => [res({ id: "repo", source: src[4], file: "config.yaml", confidence: 0.8, updatedAt: 10 })] }
    const vault = { ...src[3], search: () => [res({ id: "vault", source: src[3], file: "config.yaml", confidence: 0.95, updatedAt: 20 })] }
    const packet = await recallPacket([vault, repo], { text: "current config" })
    expect(packet.results).toHaveLength(1)
    expect(packet.results[0].source.name).toBe("repo")
  })

  test("formatMemoryContext emits bounded provenance lines for injectable results", () => {
    const text = formatMemoryContext(inject([
      res({ file: "context/cody/current.md", content: "Price wants decisive memory architecture.", confidence: 0.91 }),
    ]), 180)
    expect(text).toContain("Relevant memory:")
    expect(text).toContain("agentmemory/semantic")
    expect(text).toContain("context/cody/current.md")
  })

  test("recall compatibility returns packet results in ranked order", async () => {
    const sem = { ...src[0], search: () => [res({ id: "sem", source: src[0], title: "Semantic", content: "semantic memory" })] }
    const sess = { ...src[2], search: () => [res({ id: "sess", source: src[2], title: "Session", content: "session memory" })] }
    const got = await recall([sem, sess], { text: "last time memory" })
    expect(got.map(r => r.id)).toEqual(["sess", "sem"])
  })
})
