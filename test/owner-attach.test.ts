import { afterEach, expect, spyOn, test } from "bun:test"
import { chmodSync, mkdirSync, renameSync, writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { attach } from "../src/context/owner-attach"
import { GatewayClient } from "../src/context/gateway-client"
import { owner, wait } from "./fixture/owner"

const saved = { home: process.env.HERMES_HOME, bin: process.env.HERM_HERMES_BIN, url: process.env.HERM_GATEWAY_URL }
afterEach(() => {
  for (const [key, value] of [["HERMES_HOME", saved.home], ["HERM_HERMES_BIN", saved.bin], ["HERM_GATEWAY_URL", saved.url]]) {
    if (value === undefined) delete process.env[key!]
    else process.env[key!] = value
  }
})

test("owner attach sends profile-scoped fresh tickets, canonical chat parameters, and detaches without ending work", async () => {
  await using backend = await owner()
  process.env.HERMES_HOME = backend.home
  delete process.env.HERM_GATEWAY_URL
  const client = new GatewayClient()
  client.drain()
  try {
    client.start()
    await wait(() => client.ready)
    const first = await client.request<{ session_id: string; messages: unknown[] }>("session.create")
    expect(first.messages).toEqual([{ role: "assistant", text: "saved reply" }])
    expect(first).toMatchObject({ info: { model: "fake/model" } })
    expect((first as { info?: { title?: string } }).info?.title).toBeUndefined()
    client.setSession(first.session_id)
    await client.request("prompt.submit", { text: "hello" })
    backend.send({ method: "event", params: { type: "message.start", session_id: "s1", execution_generation: 2 } })
    await Bun.sleep(5)
    await client.request("session.interrupt")
    expect(backend.frames.find(f => f.method === "session.interrupt")?.params).toEqual({ session_id: "s1", execution_generation: 2 })
    await client.request("session.activate", { session_id: first.session_id })
    await client.request("session.close", { session_id: first.session_id })
    const create = backend.frames.find(f => f.method === "session.create")!
    expect(create.params).toEqual({ source: "tui", request_id: expect.any(String), cwd: process.cwd() })
    expect(backend.frames.find(f => f.method === "prompt.submit")?.params).toEqual({ session_id: "s1", input_id: expect.any(String), text: "hello" })
    expect(backend.frames.find(f => f.method === "session.resume")?.params).toEqual({ session_id: "s1", display_projection: true })
    expect(backend.frames.find(f => f.method === "session.detach")?.params).toEqual({ session_id: "s1", subscription_id: "sub1" })
    client.start()
    await wait(() => backend.dials.length === 2 && client.ready)
    await client.request("session.create")
    const creates = backend.frames.filter(f => f.method === "session.create")
    expect(creates[1]!.params.request_id).not.toBe(creates[0]!.params.request_id)
    expect(backend.dials[0]).toMatch(/^hermes-gateway-v1, hermes-gateway-ticket\./)
    expect(backend.dials[1]).not.toBe(backend.dials[0])
    expect(backend.controls.filter(c => c.verb === "session-ticket").map(c => c.params)).toEqual([
      { profile_id: backend.home, instance_id: "owner1", purpose: "interactive" },
      { profile_id: backend.home, instance_id: "owner1", purpose: "interactive" },
    ])
    expect(backend.frames.some(f => f.method === "session.close" || f.method === "session.activate")).toBe(false)
    expect(client.tail()).not.toContain("hermes-gateway-ticket")
    client.kill()
    await wait(() => backend.frames.filter(f => f.method === "session.detach").length >= 2)
  } finally { client.kill() }
})

test("native attach refuses missing subprotocol echo before reporting ready", async () => {
  await using backend = await owner()
  process.env.HERMES_HOME = backend.home
  delete process.env.HERM_GATEWAY_URL
  const original = globalThis.WebSocket
  globalThis.WebSocket = class extends original { override get protocol() { return "" } }
  const client = new GatewayClient()
  try {
    client.start()
    await wait(() => client.tail().includes("hermes-gateway-v1"))
    expect(client.ready).toBe(false)
    expect(client.tail()).toContain("update Hermes")
  } finally { client.kill(); globalThis.WebSocket = original }
})

test("owner heartbeat counts any inbound frame and rejects pending calls with the close reason without redial", async () => {
  await using backend = await owner({ heartbeat: false })
  process.env.HERMES_HOME = backend.home
  delete process.env.HERM_GATEWAY_URL
  const client = new GatewayClient({ ping: 10, silence: 80 })
  try {
    client.start()
    await wait(() => client.ready)
    for (let i = 0; i < 4; i++) {
      backend.send({ method: "event", params: { type: "status.update", payload: { text: "alive", kind: "info" } } })
      await Bun.sleep(25)
      expect(client.ready).toBe(true)
    }
    expect(backend.frames.some(f => f.method === "gateway.ping")).toBe(true)
    const pending = client.request("held").catch((err: Error) => err.message)
    backend.close()
    expect(await pending).toContain("owner unavailable")
    expect(client.ready).toBe(false)
    await expect(client.request("config.get")).rejects.toThrow("reconnect manually")
    expect(backend.dials).toHaveLength(1)
    client.start()
    await wait(() => client.ready)
    await wait(() => !client.ready)
    expect(client.tail()).toContain("heartbeat timeout")
  } finally { client.kill() }
})

test("control pointer authenticates its private directory and rejects shared socket modes", async () => {
  await using backend = await owner()
  const root = mkdtempSync(join(tmpdir(), "herm-pointer-"))
  const dir = join(root, `hermes-gw-${createHash("sha256").update(backend.home).digest("hex").slice(0, 16)}`)
  mkdirSync(dir, { mode: 0o700 })
  renameSync(join(backend.home, "gateway.sock"), join(dir, "control.sock"))
  writeFileSync(join(backend.home, "gateway.sock.path"), join(dir, "control.sock"), { mode: 0o600 })
  try {
    expect((await attach(backend.home, false)).protocols[0]).toBe("hermes-gateway-v1")
    chmodSync(join(dir, "control.sock"), 0o660)
    await expect(attach(backend.home, false)).rejects.toThrow("unsafe gateway control permissions")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

for (const identity of [{ runtime_protocol: 2 }, { capabilities: [] }]) test(`owner incompatibility is an update error without starting another gateway: ${JSON.stringify(identity)}`, async () => {
  await using backend = await owner({ identity })
  await expect(attach(backend.home)).rejects.toThrow("update Hermes")
})

for (const [code, state] of [[3, "incompatible"], [4, "inaccessible"], [5, "starting"], [6, "draining"], [7, "inaccessible"]] as const) test(`absent owner preserves ensure state and reason for exit ${code}`, async () => {
  const home = mkdtempSync(join(tmpdir(), "herm-ensure-"))
  const bin = join(home, "hermes")
  writeFileSync(bin, `#!/bin/sh\n[ "$*" = "gateway ensure --json --timeout 30" ] || exit 99\nprintf '%s\\n' '{"state":"${state}","reason_code":"test_refusal","detail":"operator reason"}'\nexit ${code}\n`, { mode: 0o700 })
  process.env.HERM_HERMES_BIN = bin
  try { await expect(attach(home)).rejects.toThrow(`gateway ${state}: test_refusal: operator reason`) }
  finally { rmSync(home, { recursive: true, force: true }) }
})

test("profile switch discovers the multiplexed owner and mints for the named home without spawning", async () => {
  await using backend = await owner()
  const named = join(backend.home, "profiles", "work")
  mkdirSync(named, { recursive: true, mode: 0o700 })
  backend.profiles.push(named)
  process.env.HERMES_HOME = backend.home
  process.env.HERM_HERMES_BIN = join(backend.home, "must-not-spawn")
  delete process.env.HERM_GATEWAY_URL
  const client = new GatewayClient()
  try {
    client.start()
    await wait(() => client.ready)
    process.env.HERMES_HOME = named
    client.start()
    await wait(() => client.ready && backend.dials.length === 2)
    expect(backend.controls.filter(c => c.verb === "session-ticket").map(c => c.params?.profile_id)).toEqual([backend.home, named])
    expect(backend.dials[1]).not.toBe(backend.dials[0])
  } finally { client.kill() }
})

test("absent owner ensures without terminal launch policy, then discovers and mints", async () => {
  await using backend = await owner()
  const socket = join(backend.home, "gateway.sock")
  renameSync(socket, socket + ".waiting")
  const bin = join(backend.home, "hermes")
  writeFileSync(bin, `#!/bin/sh
[ "$*" = "gateway ensure --json --timeout 30" ] || exit 99
[ -z "$HERMES_MODEL" ] || exit 98
mv "$HERMES_HOME/gateway.sock.waiting" "$HERMES_HOME/gateway.sock"
printf '%s\n' '{"state":"ready"}'
`, { mode: 0o700 })
  process.env.HERM_HERMES_BIN = bin
  const previous = process.env.HERMES_MODEL
  process.env.HERMES_MODEL = "must-stay-in-this-terminal"
  try {
    const dial = await attach(backend.home)
    expect(dial.protocols[0]).toBe("hermes-gateway-v1")
    expect(backend.controls.map(c => c.verb)).toEqual(["identify", "session-ticket"])
    expect(process.env.HERMES_MODEL).toBe("must-stay-in-this-terminal")
  } finally {
    if (previous === undefined) delete process.env.HERMES_MODEL
    else process.env.HERMES_MODEL = previous
  }
})

test("native creation preserves the terminal cwd and explicit launch settings instead of adopting owner defaults", async () => {
  await using backend = await owner()
  const prior = { model: process.env.HERMES_MODEL, cwd: process.env.HERMES_CWD, client: process.env.HERMES_TUI_CLIENT_ENV }
  process.env.HERMES_HOME = backend.home
  process.env.HERMES_MODEL = "terminal-model"
  process.env.HERMES_CWD = "/terminal/workspace"
  process.env.HERMES_TUI_CLIENT_ENV = JSON.stringify({ HERMES_KANBAN_BOARD: "terminal-board" })
  delete process.env.HERM_GATEWAY_URL
  const client = new GatewayClient()
  try {
    client.start()
    await wait(() => client.ready)
    await client.request("session.create")
    expect(backend.frames.find(f => f.method === "session.create")?.params).toMatchObject({
      source: "tui", cwd: "/terminal/workspace", model: "terminal-model", client_env: { HERMES_KANBAN_BOARD: "terminal-board" },
    })
  } finally {
    client.kill()
    for (const [key, value] of [["HERMES_MODEL", prior.model], ["HERMES_CWD", prior.cwd], ["HERMES_TUI_CLIENT_ENV", prior.client]]) {
      if (value === undefined) delete process.env[key!]
      else process.env[key!] = value
    }
  }
})

for (const state of ["starting", "draining"]) test(`an answering ${state} owner reports its state rather than suggesting an update`, async () => {
  await using backend = await owner({ identity: { state, capabilities: [] } })
  process.env.HERM_HERMES_BIN = join(backend.home, "must-not-start")
  await expect(attach(backend.home)).rejects.toThrow(`gateway ${state}`)
})

test("a transient describe failure does not poison subsequent creation on the same connection", async () => {
  await using backend = await owner({ failures: 1 })
  process.env.HERMES_HOME = backend.home
  delete process.env.HERM_GATEWAY_URL
  const client = new GatewayClient()
  try {
    client.start()
    await wait(() => client.tail().includes("temporary describe failure"))
    await expect(client.request("session.create")).resolves.toMatchObject({ session_id: "s1" })
    expect(backend.dials).toHaveLength(1)
    expect(backend.frames.filter(f => f.method === "runtime.describe")).toHaveLength(2)
  } finally { client.kill() }
})

test("a malformed ticket is never included in the visible bootstrap error", async () => {
  await using backend = await owner({ ticket: "PRIVATE-TICKET-SENTINEL!" })
  process.env.HERMES_HOME = backend.home
  delete process.env.HERM_GATEWAY_URL
  const client = new GatewayClient()
  try {
    client.start()
    await wait(() => client.tail().includes("invalid gateway ticket"))
    expect(client.tail()).not.toContain("PRIVATE-TICKET-SENTINEL")
    expect(backend.dials).toHaveLength(0)
  } finally { client.kill() }
})

test("default heartbeat sends at 15 seconds and disconnects at 45 seconds of silence", async () => {
  await using backend = await owner({ heartbeat: false })
  process.env.HERMES_HOME = backend.home
  delete process.env.HERM_GATEWAY_URL
  const original = globalThis.setInterval
  let tick = () => {}
  let delay: number | undefined
  let now = 0
  const clock = spyOn(performance, "now").mockImplementation(() => now)
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
    tick = fn
    delay = ms
    return original(() => {}, 1_000_000)
  }) as typeof setInterval)
  const client = new GatewayClient()
  try {
    client.start()
    await wait(() => client.ready)
    await client.request("client.capabilities", { server_requests: true })
    expect(delay).toBe(15000)
    now = 15000
    tick()
    await wait(() => backend.frames.some(f => f.method === "gateway.ping"))
    now = 44999
    tick()
    expect(client.ready).toBe(true)
    now = 45000
    tick()
    expect(client.ready).toBe(false)
    expect(client.tail()).toContain("heartbeat timeout")
  } finally { client.kill(); interval.mockRestore(); clock.mockRestore() }
})
