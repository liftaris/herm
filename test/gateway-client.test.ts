import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { GatewayClient, gatewayUrl, websocketUrl } from "../src/context/gateway-client"
import type { GatewayEvent } from "../src/context/wire"

class FakeSocket extends EventTarget {
  static list: FakeSocket[] = []

  readyState = 0
  sent: string[] = []

  constructor(readonly url: string) {
    super()
    FakeSocket.list.push(this)
  }

  send(data: string) {
    if (this.readyState !== 1) throw new Error("socket closed")
    this.sent.push(data)
    const frame = JSON.parse(data)
    if (frame.method === "client.capabilities") queueMicrotask(() => this.message(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} })))
  }

  close(code = 1000) {
    this.readyState = 3
    this.dispatchEvent(new CloseEvent("close", { code }))
  }

  open() {
    this.readyState = 1
    this.dispatchEvent(new Event("open"))
    this.message(JSON.stringify({ method: "event", params: { type: "gateway.ready" } }))
  }

  message(data: string) {
    this.dispatchEvent(new MessageEvent("message", { data }))
  }
}

const original = globalThis.WebSocket
const timer = globalThis.setTimeout

beforeEach(() => {
  FakeSocket.list = []
})

afterEach(() => {
  delete process.env.HERM_GATEWAY_URL
  delete process.env.HERMES_TUI_GATEWAY_URL
  if (original) globalThis.WebSocket = original
  else delete (globalThis as { WebSocket?: unknown }).WebSocket
  globalThis.setTimeout = timer
})

describe("GatewayClient websocket attach mode", () => {
  test("startup timeout closes a wedged websocket and reports exit", async () => {
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => (
      timer(args[0], args[1] === 15_000 ? 0 : args[1], ...args.slice(2))
    )) as typeof setTimeout
    process.env.HERM_GATEWAY_URL = "ws://gateway.test/api/ws?token=abc"
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const gw = new GatewayClient()
    let exits = 0
    gw.on("exit", () => { exits++ })
    gw.drain()

    gw.start()
    await Bun.sleep(20)

    expect(FakeSocket.list[0]?.readyState).toBe(3)
    expect(gw.tail()).toContain("timed out")
    expect(gw.tail()).not.toContain("token=abc")
    expect(exits).toBe(1)
    gw.kill()
  })

  test("times out an unanswered websocket request", async () => {
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => (
      timer(args[0], args[1] === 120_000 ? 0 : args[1], ...args.slice(2))
    )) as typeof setTimeout
    process.env.HERM_GATEWAY_URL = "ws://gateway.test/api/ws?token=abc"
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const gw = new GatewayClient()
    let err: Error | undefined

    gw.request("session.create").catch(e => { err = e })
    await Promise.resolve()
    FakeSocket.list[0]!.open()
    await new Promise(resolve => timer(resolve, 10))

    expect(err?.message).toBe("timeout: session.create")
    gw.kill()
  })

  test("rejects in-flight websocket requests on kill", async () => {
    process.env.HERM_GATEWAY_URL = "ws://gateway.test/api/ws?token=abc"
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const gw = new GatewayClient()
    let err: Error | undefined

    gw.request("session.create").catch(e => { err = e })
    await Promise.resolve()
    const ws = FakeSocket.list[0]!
    ws.open()
    await Bun.sleep(0)
    expect(ws.sent).toHaveLength(2)

    gw.kill()
    await Bun.sleep(0)

    expect(err?.message).toContain("gateway websocket closed")
  })

  test("ignores events from superseded websocket connections", async () => {
    process.env.HERM_GATEWAY_URL = "ws://gateway.test/api/ws?token=first"
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const gw = new GatewayClient()
    const events: string[] = []

    gw.on("event", ev => events.push(ev.type))
    const first = gw.request("session.create")
    await Bun.sleep(0)
    const old = FakeSocket.list[0]!
    old.open()
    await Bun.sleep(0)
    const a = JSON.parse(old.sent.find(data => JSON.parse(data).method === "session.create")!) as { id: string }
    old.message(JSON.stringify({ jsonrpc: "2.0", id: a.id, result: null }))
    await first
    gw.drain()

    process.env.HERM_GATEWAY_URL = "ws://gateway.test/api/ws?token=second"
    const second = gw.request("session.create")
    const next = FakeSocket.list[1]!
    old.message(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "tool.start" } }))
    next.open()
    await Bun.sleep(0)
    const b = JSON.parse(next.sent.find(data => JSON.parse(data).method === "session.create")!) as { id: string }
    next.message(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: null }))

    expect(events).toEqual(["gateway.ready", "gateway.ready"])
    await second
    gw.kill()
  })

  test("uses HERM_GATEWAY_URL for JSON-RPC requests and events", async () => {
    process.env.HERM_GATEWAY_URL = "ws://gateway.test/api/ws?token=abc"
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const gw = new GatewayClient()
    const events: string[] = []

    gw.on("event", ev => events.push(ev.type))
    gw.start()
    const ws = FakeSocket.list[0]!
    const req = gw.request<{ ok: boolean }>("session.create", { cols: 80 })

    expect(ws.sent).toHaveLength(0)
    ws.open()
    await Bun.sleep(0)
    expect(ws.sent).toHaveLength(2)

    const frame = JSON.parse(ws.sent.find(data => JSON.parse(data).method === "session.create")!) as { id: string; method: string; params: { cols: number } }
    expect(frame.method).toBe("session.create")
    expect(frame.params.cols).toBe(80)

    gw.drain()
    ws.message(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "tool.start" } }))
    ws.message(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { ok: true } }))

    expect(events).toEqual(["gateway.ready", "tool.start"])
    expect(gw.ready).toBe(true)
    await expect(req).resolves.toEqual({ ok: true })
    gw.kill()
  })

  test("accepts producer-derived gateway event envelope fixtures", async () => {
    process.env.HERM_GATEWAY_URL = "ws://gateway.test/api/ws?token=abc"
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const fixture = await Bun.file(new URL("fixtures/hermes/gateway-events.json", import.meta.url)).json() as {
      frames: Array<{ jsonrpc: string; method: string; params: { type: string } }>
    }
    const gw = new GatewayClient()
    const events: string[] = []

    gw.on("event", ev => events.push(ev.type))
    gw.drain()
    gw.start()
    const ws = FakeSocket.list[0]!
    ws.open()
    await Bun.sleep(0)
    for (const frame of fixture.frames) {
      expect(frame.jsonrpc).toBe("2.0")
      expect(frame.method).toBe("event")
      ws.message(JSON.stringify(frame))
    }

    expect(events).toEqual(["gateway.ready", ...fixture.frames.map(frame => frame.params.type)])
    expect(gw.ready).toBe(true)
    gw.kill()
  })

  test("socket close emits exit and reconnects with the reusable URL", () => {
    process.env.HERM_GATEWAY_URL = "ws://gateway.test/api/ws?internal=abc"
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const gw = new GatewayClient()
    let exits = 0
    gw.on("exit", () => { exits++ })
    gw.drain()

    gw.start()
    FakeSocket.list[0]!.close(1006)
    expect(exits).toBe(1)
    gw.start()
    expect(FakeSocket.list).toHaveLength(2)
    expect(FakeSocket.list[1]?.url).toBe("ws://gateway.test/api/ws?internal=abc")
    gw.kill()
  })

  test("accepts upstream HERMES_TUI_GATEWAY_URL fallback", () => {
    process.env.HERMES_TUI_GATEWAY_URL = "ws://upstream.test/api/ws?token=abc"
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const gw = new GatewayClient()

    gw.start()
    expect(FakeSocket.list[0]?.url).toBe("ws://upstream.test/api/ws?token=abc")
    gw.kill()
  })

  test("HERM_GATEWAY_URL overrides the upstream fallback", () => {
    process.env.HERM_GATEWAY_URL = "ws://primary.test/api/ws?token=one"
    process.env.HERMES_TUI_GATEWAY_URL = "ws://fallback.test/api/ws?token=two"
    expect(gatewayUrl()).toBe("ws://primary.test/api/ws?token=one")
  })

  test("normalizes secure dashboard prefixes without replacing credentials", () => {
    process.env.HERM_GATEWAY_URL = "https://gateway.test/hermes/?internal=abc"
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const gw = new GatewayClient()

    gw.start()
    expect(FakeSocket.list[0]?.url).toBe("wss://gateway.test/hermes/api/ws?internal=abc")
    gw.kill()
  })

  test("normalizes root URLs and rejects unsupported protocols", () => {
    expect(websocketUrl("ws://127.0.0.1:9119/?token=abc"))
      .toBe("ws://127.0.0.1:9119/api/ws?token=abc")
    expect(() => websocketUrl("ftp://gateway.test/?token=abc"))
      .toThrow("unsupported gateway URL protocol: ftp:")
  })
})

const ev = (value: unknown) => value as GatewayEvent

describe("GatewayClient diagnostics", () => {
  test("unknown gateway events enter structured redacted diagnostics", () => {
    const gw = new GatewayClient()
    gw.diagnose(ev({
      type: "future.event",
      contract_version: 4,
      payload: {
        text: "visible",
        token: "SECRET_TOKEN_SENTINEL",
        nested: { password: "SECRET_PASSWORD_SENTINEL" },
      },
    }), "websocket")

    const log = gw.tail(5)
    expect(log).toContain("[event unknown]")
    expect(log).toContain("type=future.event")
    expect(log).toContain("source=websocket")
    expect(log).toContain("contract=4")
    expect(log).toContain("count=1")
    expect(log).toContain("visible")
    expect(log).toContain("[redacted]")
    expect(log).not.toContain("SECRET_TOKEN_SENTINEL")
    expect(log).not.toContain("SECRET_PASSWORD_SENTINEL")
  })

  test("repeated unknown events update the first diagnostic with aggregate count", () => {
    const gw = new GatewayClient()
    gw.diagnose(ev({ type: "future.repeat", payload: { marker: "FIRST_PAYLOAD" } }), "websocket")
    gw.diagnose(ev({ type: "future.repeat", payload: { marker: "SECOND_PAYLOAD" } }), "websocket")
    gw.diagnose(ev({ type: "future.repeat", payload: { marker: "THIRD_PAYLOAD" } }), "websocket")

    const rows = gw.tail(10).split("\n").filter(Boolean)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain("count=3")
    expect(rows[0]).toContain("FIRST_PAYLOAD")
    expect(rows[0]).not.toContain("SECOND_PAYLOAD")
    expect(rows[0]).not.toContain("THIRD_PAYLOAD")
  })

  test("known intentionally ignored events are not classified as unknown", () => {
    const gw = new GatewayClient()
    gw.diagnose(ev({ type: "session.title", payload: { session_id: "s", title: "t" } }), "control")
    gw.diagnose(ev({ type: "voice.status", payload: { state: "idle" } }), "control")
    expect(gw.tail(10)).not.toContain("[event unknown]")
  })

  test("diagnostics cannot crash on circular payloads", () => {
    const payload: Record<string, unknown> = { text: "safe" }
    payload.self = payload
    const gw = new GatewayClient()
    expect(() => gw.diagnose(ev({ type: "future.circular", payload }), "control")).not.toThrow()
    expect(gw.tail(5)).toContain("[circular]")
  })
})
