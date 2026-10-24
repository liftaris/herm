import { afterEach, expect, test } from "bun:test"
import { act } from "react"
import type { ServerWebSocket } from "bun"
import { App } from "../src/app"
import { GatewayClient } from "../src/context/gateway-client"
import { mountNode, until } from "./harness"

type Frame = { jsonrpc?: string; id?: string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } }
const previous = process.env.HERM_GATEWAY_URL
let stop: (() => void) | undefined

afterEach(() => {
  stop?.()
  stop = undefined
  if (previous === undefined) delete process.env.HERM_GATEWAY_URL
  else process.env.HERM_GATEWAY_URL = previous
})

function backend(open: Frame[] = []) {
  const frames: Frame[] = []
  let peer: ServerWebSocket<unknown> | undefined
  const info = { desktop_contract: 8, session_id: "protocol-sid", model: "protocol-model", tools: {}, skills: {} }
  const server = Bun.serve({
    port: 0,
    fetch(req, server) { return server.upgrade(req) ? undefined : new Response(null, { status: 400 }) },
    websocket: {
      open(ws) {
        peer = ws
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready" } }))
      },
      message(ws, data) {
        const frame = JSON.parse(String(data)) as Frame
        frames.push(frame)
        if (!frame.method) return
        const result = (() => {
          switch (frame.method) {
            case "client.capabilities": return {}
            case "session.create":
            case "session.resume":
            case "session.activate": return { session_id: "protocol-sid", info, messages: [], open_requests: open }
            case "config.get": return frame.params?.key === "full" ? { config: {} } : {}
            case "commands.catalog": return { pairs: [] }
            case "session.title": return { title: "" }
            case "delegation.status": return { active: [] }
            case "agents.list": return { processes: [] }
            case "approval.received": return { acknowledged: true }
            case "session.branch": return { session_id: "protocol-sid" }
            case "session.close": return { closed: true }
            case "request.answer": return { status: "ok" }
            case "clarify.lock": return { status: "ok", remaining: ["pending"] }
            case "prompt.submit": return { accepted: true }
            default: throw new Error(`undeclared protocol fixture RPC: ${frame.method}`)
          }
        })()
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }))
        if (frame.method === "session.create" || frame.method === "session.resume")
          ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "session.info", payload: info } }))
      },
    },
  })
  process.env.HERM_GATEWAY_URL = `ws://127.0.0.1:${server.port}`
  const gw = new GatewayClient()
  stop = () => { gw.removeAllListeners(); gw.kill(); server.stop(true) }
  return {
    gw, frames,
    send: (frame: Frame) => peer!.send(JSON.stringify({ jsonrpc: "2.0", ...frame })),
    ask: (id: string, method: string, params: Record<string, unknown>) => peer!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: { session_id: "protocol-sid", ...params } })),
  }
}

test("contract 8 sends prompts and cards answer the server request IDs without removed RPCs", async () => {
  const b = backend()
  await using t = await mountNode(<App gateway={b.gw} launch={{ mode: "new", splash: false }} />)
  await until(t, () => t.frame().includes("Ready"))
  expect(b.frames.find(f => f.method === "client.capabilities")?.params).toEqual({ server_requests: true })
  await act(async () => { await t.keys.typeText("hello contract eight") })
  act(() => t.keys.pressEnter())
  await until(t, () => b.frames.some(f => f.method === "prompt.submit"))
  expect(b.frames.find(f => f.method === "prompt.submit")?.params?.text).toBe("hello contract eight")

  b.ask("srq-approval", "approval", { request_id: "approval-queue-id", command: "printf approved", description: "harmless command", choices: ["once", "deny"], allow_permanent: false })
  await until(t, () => t.frame().includes("printf approved"))
  expect(t.frame()).not.toContain("Never ask")
  t.resize(78, 42)
  await t.settle()
  await t.settle()
  expect(t.frame()).toContain("Allow once")
  expect(t.frame()).toContain("Deny")
  act(() => t.keys.pressEnter())
  await until(t, () => b.frames.some(f => f.id === "srq-approval"))
  expect(b.frames.find(f => f.id === "srq-approval")).toEqual({ jsonrpc: "2.0", id: "srq-approval", result: { choice: "once" } })

  b.ask("srq-clarify", "clarify", { questions: [
    { qid: "color", question: "Pick a color", choices: ["red", "blue"], multi_select: false },
    { qid: "targets", question: "Pick targets", choices: ["linux", "mac"], multi_select: true },
    { qid: "note", question: "Optional note", choices: null, multi_select: false },
  ] })
  await until(t, () => t.frame().includes("Pick a color"))
  act(() => t.keys.pressKey("2"))
  await until(t, () => t.frame().includes("Pick targets"))
  act(() => t.keys.pressKey("1"))
  await t.settle()
  act(() => t.keys.pressKey("2"))
  await t.settle()
  act(() => t.keys.pressEnter())
  await until(t, () => t.frame().includes("Optional note"))
  act(() => t.keys.pressEnter())
  await until(t, () => b.frames.some(f => f.id === "srq-clarify"))
  expect(b.frames.filter(f => f.method === "clarify.lock").map(f => f.params)).toEqual([
    { session_id: "protocol-sid", request_id: "srq-clarify", question_id: "color", answer: "blue" },
    { session_id: "protocol-sid", request_id: "srq-clarify", question_id: "targets", answer: "linux, mac" },
  ])
  expect(b.frames.find(f => f.id === "srq-clarify")?.result).toEqual({ answers: { color: "blue", targets: "linux, mac", note: null }, outcome: "submitted" })

  for (const method of ["sudo", "secret"]) {
    b.ask(`srq-${method}`, method, { env_var: "PRIVATE_KEY", prompt: "Provide a key", command: "sudo true" })
    await until(t, () => t.frame().includes(method === "sudo" ? "Sudo required" : "Secret: PRIVATE_KEY"))
    await act(async () => { await t.keys.typeText("private-value") })
    await t.settle()
    expect(t.frame()).not.toContain("private-value")
    act(() => t.keys.pressEnter())
    await until(t, () => b.frames.some(f => f.id === `srq-${method}`))
    expect(b.frames.find(f => f.id === `srq-${method}`)?.result).toEqual({ value: "private-value" })
  }
  expect(b.frames.filter(f => f.method?.endsWith(".respond"))).toEqual([])
})

test("cancel withdraws only its card and unsupported requests fail immediately with 4404", async () => {
  const b = backend()
  await using t = await mountNode(<App gateway={b.gw} launch={{ mode: "new", splash: false }} />)
  await until(t, () => t.frame().includes("Ready"))
  b.ask("srq-cancel", "secret", { env_var: "CANCEL_ME", prompt: "Cancelled prompt" })
  await until(t, () => t.frame().includes("CANCEL_ME"))
  b.send({ method: "event", params: { type: "request.cancel", session_id: "protocol-sid", payload: { id: "srq-cancel", method: "secret", reason: "timeout" } } })
  await until(t, () => !t.frame().includes("CANCEL_ME"))
  await expect(b.gw.answer("srq-cancel", { value: "stale" })).rejects.toThrow("no longer open")
  for (const method of ["terminal.read", "preview.read", "preview.act", "window.read", "tour", "theme.apply", "display.install.sudo", "setup_beat", "theme.pick", "vault.unlock_prompt", "vault.save_login", "vault.code", "future.request"]) {
    b.ask(`unsupported-${method}`, method, {})
    await until(t, () => b.frames.some(f => f.id === `unsupported-${method}`))
    expect(b.frames.find(f => f.id === `unsupported-${method}`)?.error?.code).toBe(4404)
  }
  expect(b.frames.some(f => f.id === "srq-cancel")).toBe(false)
})

test("resume replays a clarify batch after history and answers through request.answer", async () => {
  const b = backend([{ id: "srq-replay", method: "clarify", params: { session_id: "protocol-sid", questions: [
    { qid: "locked", question: "Already locked", choices: null, multi_select: false },
    { qid: "pending", question: "Replayed question", choices: ["continue", "stop"], multi_select: false },
  ], answers: { locked: "kept" } } }])
  await using t = await mountNode(<App gateway={b.gw} launch={{ mode: "resume", sid: "stored-id", splash: false }} />)
  await until(t, () => t.frame().includes("Replayed question"))
  expect(t.frame()).not.toContain("Already locked")
  act(() => t.keys.pressKey("1"))
  await until(t, () => b.frames.some(f => f.method === "request.answer"))
  expect(b.frames.find(f => f.method === "request.answer")?.params).toMatchObject({ id: "srq-replay", result: { answers: { locked: "kept", pending: "continue" }, outcome: "submitted" } })
})


test("activation restores a waiting approval and acknowledges the queue entry when its card mounts", async () => {
  const b = backend([{ id: "srq-active", method: "approval", params: {
    session_id: "protocol-sid", request_id: "queue-active", command: "printf active", description: "replayed approval", choices: ["once", "deny"],
  } }])
  await using t = await mountNode(<App gateway={b.gw} launch={{ mode: "new", splash: false }} />)
  await until(t, () => t.frame().includes("Ready"))
  await act(async () => { await t.keys.typeText("/branch replay") })
  act(() => t.keys.pressEnter())
  await until(t, () => t.frame().includes("printf active"))
  expect(b.frames.find(f => f.method === "session.activate")?.params?.session_id).toBe("protocol-sid")
  await until(t, () => b.frames.some(f => f.method === "approval.received"))
  expect(b.frames.find(f => f.method === "approval.received")?.params?.request_id).toBe("queue-active")
  const rows = t.frame().split("\n")
  const y = rows.findIndex(row => row.includes("Allow once"))
  await act(async () => { await t.mouse.pressDown(rows[y].indexOf("Allow once"), y) })
  await until(t, () => b.frames.some(f => f.method === "request.answer"))
  expect(b.frames.find(f => f.method === "request.answer")?.params).toMatchObject({ id: "srq-active", result: { choice: "once" } })
})
