import { describe, expect, test } from "bun:test"
import { formatProcessNotification, mapEvent, type Side } from "../src/context/events"
import type { GatewayEvent } from "../src/context/wire"

function map(ev: GatewayEvent, side: Partial<Side> = {}) {
  const calls: Record<string, unknown[]> = {}
  const spy = (name: string) => (...a: unknown[]) => { calls[name] = a }
  const s: Side = {
    onReady: spy("ready"), onSessionInfo: spy("info"), onUsage: spy("usage"),
    onTurnComplete: spy("done"), onStatus: spy("status"),
    onBackground: spy("bg"), onBtw: spy("btw"), ...side,
  }
  return { action: mapEvent(ev, s), calls }
}

describe("mapEvent", () => {
  test("gateway.ready → onReady, no action", () => {
    const r = map({ type: "gateway.ready" })
    expect(r.action).toBeNull()
    expect(r.calls.ready).toBeDefined()
  })

  test("session.info counts tools/skills from dict-of-arrays", () => {
    const r = map({
      type: "session.info",
      payload: { model: "m", tools: { a: ["x", "y"], b: ["z"] }, skills: { s: ["k"] } },
    })
    expect(r.action).toEqual({ kind: "system", text: "Connected — m · 3 tools · 1 skills" })
    expect(r.calls.info).toBeDefined()
  })

  test("session.info credential_warning → onStatus", () => {
    const r = map({ type: "session.info", payload: { credential_warning: "no key" } })
    expect(r.calls.status).toEqual(["no key"])
  })

  test("session.title is side-effect only", () => {
    const got: unknown[] = []
    const r = map({
      type: "session.title",
      payload: { session_id: "sid-a", title: "Auto Title" },
    }, { onSessionTitle: (...a) => got.push(a) })
    expect(r.action).toBeNull()
    expect(got).toEqual([["sid-a", "Auto Title"]])
  })

  test("message.delta empty → null", () => {
    expect(map({ type: "message.delta", payload: { text: "" } }).action).toBeNull()
    expect(map({ type: "message.delta", payload: { text: "x" } }).action)
      .toEqual({ kind: "message.delta", chunk: "x" })
  })

  test("message.complete normal", () => {
    const u = { input: 1, output: 2, total: 3 }
    const r = map({ type: "message.complete", payload: { text: "hi", usage: u } })
    expect(r.action).toEqual({ kind: "message.complete", text: "hi", usage: u })
    expect(r.calls.usage).toEqual([u])
    expect(r.calls.done).toBeDefined()
  })

  test("message.complete status=error → error action", () => {
    const r = map({ type: "message.complete", payload: { text: null, status: "error" } })
    expect(r.action?.kind).toBe("error")
  })

  test("message.complete status=interrupted appends marker", () => {
    const r = map({ type: "message.complete", payload: { text: "partial", status: "interrupted" } })
    expect(r.action).toMatchObject({ kind: "message.complete" })
    expect(r.action?.kind === "message.complete" && r.action.text).toContain("[interrupted]")
  })

  test("tool.start / tool.complete map ids and summary", () => {
    expect(map({ type: "tool.start", payload: { tool_id: "t1", name: "read", context: "f.ts" } }).action)
      .toEqual({ kind: "tool.start", id: "t1", name: "read", preview: "f.ts" })
    expect(map({ type: "tool.complete", payload: { tool_id: "t1", summary: "5 lines" } }).action)
      .toMatchObject({ kind: "tool.complete", id: "t1", summary: "5 lines" })
  })

  test("verbose tool payload maps args/result text and duration_s", () => {
    expect(map({
      type: "tool.start",
      payload: { tool_id: "t1", name: "patch", context: "f.ts", args_text: "{\"path\":\"f.ts\"}" },
    }).action).toEqual({
      kind: "tool.start", id: "t1", name: "patch", preview: "f.ts", args: "{\"path\":\"f.ts\"}",
    })

    expect(map({
      type: "tool.complete",
      payload: { tool_id: "t1", duration_s: 1.25, result_text: "patched", inline_diff: "diff" },
    }).action).toEqual({
      kind: "tool.complete", id: "t1", duration: 1250, result: "patched", inline_diff: "diff",
    })
  })

  test("status.update: cosmetic → null; lifecycle → system", () => {
    const a = map({ type: "status.update", payload: { kind: "status", text: "spin" } })
    expect(a.action).toBeNull()
    expect(a.calls.status).toEqual(["spin"])
    const b = map({ type: "status.update", payload: { kind: "lifecycle", text: "HTTP 404" } })
    expect(b.action).toEqual({ kind: "system", text: "HTTP 404" })
  })

  test("status.update kind=process is transient status only", () => {
    const text = "[IMPORTANT: Background process proc_abc completed (exit code 0).\nCommand: bun test\nOutput:\n…long stdout…]"
    const done = map({ type: "status.update", payload: { kind: "process", text } })
    expect(done.action).toBeNull()
    expect(done.calls.status).toEqual(["proc_abc exited 0 · bun test"])
  })

  test("notification events route to keyed notice controller", () => {
    const seen: unknown[] = []
    const notices = {
      show: (o: unknown) => seen.push(["show", o]),
      clear: (k: string) => seen.push(["clear", k]),
      error: () => {},
    }
    const show = map({
      type: "notification.show",
      payload: { text: "Credit access paused", level: "error", kind: "sticky", key: "credits.depleted" },
    }, { notices })
    expect(show.action).toBeNull()
    expect(seen[0]).toEqual(["show", {
      key: "credits.depleted",
      variant: "error",
      message: "Credit access paused",
      duration: null,
    }])

    const clear = map({ type: "notification.clear", payload: { key: "credits.depleted" } }, { notices })
    expect(clear.action).toBeNull()
    expect(seen[1]).toEqual(["clear", "credits.depleted"])
  })

  test("formatProcessNotification preserves completion and watch-pattern shapes", () => {
    expect(formatProcessNotification(
      "[IMPORTANT: Background process proc_abc completed (exit code 0).\nCommand: bun test\nOutput:\n…long stdout…]",
    )).toBe("proc_abc exited 0 · bun test")
    expect(formatProcessNotification(
      "[IMPORTANT: Background process srv_1 matched watch pattern \"ready\".\nCommand: bun run dev\nMatched output:\nApplication startup complete]",
    )).toBe("srv_1 matched \"ready\" · bun run dev")
    expect(formatProcessNotification("weird shape")).toBe("weird shape")
  })

  test("gateway.stderr: errorish → nonfatal error (full line, no slice); benign → null", () => {
    expect(map({ type: "gateway.stderr", payload: { line: "⚠️ API call failed (HTTP 404)" } }).action)
      .toMatchObject({ kind: "error", fatal: false })
    expect(map({ type: "gateway.stderr", payload: { line: "Traceback (most recent call last):" } }).action)
      .toMatchObject({ kind: "error", fatal: false })
    expect(map({ type: "gateway.stderr", payload: { line: "INFO: loaded 5 skills" } }).action)
      .toBeNull()
    // Long tracebacks are passed through verbatim — the /logs ring (gw.tail)
    // keeps the full line regardless, but the transcript row must not drop
    // context to an arbitrary slice either.
    const long = "Traceback: " + "x".repeat(500)
    expect(map({ type: "gateway.stderr", payload: { line: long } }).action)
      .toEqual({ kind: "error", text: long, fatal: false })
  })

  test("gateway.start_timeout / protocol_error surface", () => {
    expect(map({ type: "gateway.start_timeout", payload: { python: "py", cwd: "/x" } }).action?.kind)
      .toBe("error")
    expect(map({ type: "gateway.protocol_error", payload: { preview: "bad" } }).action)
      .toEqual({ kind: "system", text: "protocol error: bad" })
  })

  test("thinking.delta is status-only; reasoning.* → thinking action", () => {
    const r = map({ type: "thinking.delta", payload: { text: "(•_•) formulating" } })
    expect(r.action).toBeNull()
    expect(r.calls.status).toEqual(["(•_•) formulating"])
    expect(map({ type: "reasoning.delta", payload: { text: "hmm" } }).action)
      .toEqual({ kind: "thinking", text: "hmm", final: false })
    expect(map({ type: "reasoning.available", payload: { text: "done" } }).action)
      .toEqual({ kind: "thinking", text: "done", final: true })
    expect(map({ type: "reasoning.available", payload: { text: "done", verbose: true } }).action)
      .toEqual({ kind: "thinking", text: "done", final: true, verbose: true })
  })

  test("moa.reference maps to a visible committed reference block", () => {
    expect(map({
      type: "moa.reference",
      payload: { label: "openrouter:openai/gpt-5.5", text: "Paris.", index: 1, count: 2 },
    }).action).toEqual({
      kind: "reference",
      text: "◇ Reference 1/2 — openrouter:openai/gpt-5.5\nParis.",
    })
  })

  test("moa.aggregating is transient status only", () => {
    const r = map({ type: "moa.aggregating", payload: { aggregator: "openrouter:anthropic/claude-opus-4.8" } })
    expect(r.action).toBeNull()
    expect(r.calls.status).toEqual(["aggregating with openrouter:anthropic/claude-opus-4.8…"])
  })

  test("request events return prompt actions (no side callback)", () => {
    expect(map({ type: "clarify.request", payload: { request_id: "x", question: "?", choices: null } }).action)
      .toEqual({ kind: "prompt", id: "x", req: { variant: "clarify", request_id: "x", question: "?", choices: null } })
    expect(map({ type: "approval.request", payload: { command: "rm", description: "d" } }).action)
      .toMatchObject({ kind: "prompt", req: { variant: "approval", command: "rm", description: "d" } })
    expect(map({ type: "sudo.request", payload: { request_id: "s" } }).action)
      .toEqual({ kind: "prompt", id: "s", req: { variant: "sudo", request_id: "s" } })
    expect(map({ type: "secret.request", payload: { request_id: "k", prompt: "p", env_var: "API_KEY" } }).action)
      .toEqual({ kind: "prompt", id: "k", req: { variant: "secret", request_id: "k", prompt: "p", env_var: "API_KEY" } })
  })

  test("review.summary → persistent system line (trimmed)", () => {
    expect(map({ type: "review.summary", payload: { text: "💾 Self-improvement review: patched skill foo" } }).action)
      .toEqual({ kind: "system", text: "💾 Self-improvement review: patched skill foo" })
    // Leading/trailing whitespace is stripped.
    expect(map({ type: "review.summary", payload: { text: "  padded\n\n" } }).action)
      .toEqual({ kind: "system", text: "padded" })
  })

  test("review.summary with empty/missing text → null (no blank system line)", () => {
    expect(map({ type: "review.summary", payload: { text: "" } }).action).toBeNull()
    expect(map({ type: "review.summary", payload: { text: "   \n\t" } }).action).toBeNull()
    expect(map({ type: "review.summary", payload: undefined } as GatewayEvent).action).toBeNull()
    expect(map({ type: "review.summary" } as GatewayEvent).action).toBeNull()
  })
})
