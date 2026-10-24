import { createServer } from "node:net"
import { chmodSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ServerWebSocket } from "bun"

export async function owner(opts: { identity?: Record<string, unknown>; heartbeat?: boolean; failures?: number; ticket?: string; ready?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "herm-owner-"))
  chmodSync(home, 0o700)
  const profiles: string[] = []
  const frames: Array<{ id?: string; method: string; params: Record<string, unknown> }> = []
  const controls: Array<{ verb: string; params?: Record<string, unknown> }> = []
  const dials: string[] = []
  const tickets = new Set<string>()
  const peers = new Set<ServerWebSocket<unknown>>()
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const protocols = req.headers.get("sec-websocket-protocol") ?? ""
      dials.push(protocols)
      const ticket = protocols.split(/,\s*/).find(p => p.startsWith("hermes-gateway-ticket."))?.slice("hermes-gateway-ticket.".length)
      if (!ticket || !tickets.delete(ticket)) return new Response("spent ticket", { status: 403 })
      return server.upgrade(req, { headers: { "Sec-WebSocket-Protocol": "hermes-gateway-v1" } }) ? undefined : new Response(null, { status: 400 })
    },
    websocket: {
      open(ws) {
        peers.add(ws)
        if (opts.ready !== false) ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready" } }))
      },
      close(ws) { peers.delete(ws) },
      message(ws, data) {
        const frame = JSON.parse(String(data))
        frames.push(frame)
        if (!frame.method || frame.method === "held" || frame.method === "gateway.ping" && opts.heartbeat === false) return
        if (frame.method === "runtime.describe" && opts.failures) {
          opts.failures--
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32000, message: "temporary describe failure" } }))
          return
        }
        const result = frame.method === "runtime.describe" ? { session_create: { sources: ["tui"], parameters: ["source", "request_id", "cwd", "model", "client_env"] } }
          : frame.method === "session.create" || frame.method === "session.resume" ? { session_id: frame.params.session_id ?? "s1", subscription_id: "sub1", execution_generation: 0, info: { model: "fake/model", title: null }, display_messages: [{ role: "assistant", text: "saved reply" }] }
          : { ok: true }
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }))
      },
    },
  })
  const control = createServer(socket => {
    socket.once("data", chunk => {
      const frame = JSON.parse(chunk.toString())
      controls.push(frame)
      const ticket = crypto.randomUUID()
      if (frame.verb === "session-ticket") tickets.add(ticket)
      const result = frame.verb === "identify" ? {
        runtime_protocol: 1, state: "ready", instance_id: "owner1", capabilities: ["session-authority-v1"],
        served_profiles: [home, ...profiles].map(home => ({ home, profile_id: home })), api_origin: `http://127.0.0.1:${server.port}`, ...opts.identity,
      } : { runtime_protocol: 1, profile_id: frame.params.profile_id, instance_id: frame.params.instance_id, ticket: opts.ticket ?? ticket }
      socket.end(JSON.stringify({ protocol: 1, id: 1, ok: true, result }) + "\n")
    })
  })
  await new Promise<void>(resolve => control.listen(join(home, "gateway.sock"), resolve))
  chmodSync(join(home, "gateway.sock"), 0o600)
  return {
    home, profiles, frames, controls, dials,
    send(value: unknown) { for (const peer of peers) peer.send(JSON.stringify(value)) },
    close() { for (const peer of peers) peer.close(1011, "owner unavailable") },
    async [Symbol.asyncDispose]() {
      server.stop(true)
      await new Promise<void>(resolve => control.close(() => resolve()))
      rmSync(home, { recursive: true, force: true })
    },
  }
}

export async function wait(predicate: () => boolean) {
  const end = Date.now() + 2000
  while (!predicate() && Date.now() < end) await Bun.sleep(5)
  if (!predicate()) throw new Error("condition not observed before deadline")
}
