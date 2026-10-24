import { join } from "node:path"
import { homedir } from "node:os"
import { z } from "zod"
import { attach } from "../src/context/owner-attach"

const profile = Bun.argv.indexOf("--profile")
if (profile >= 0 && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(Bun.argv[profile + 1] ?? "")) throw new Error("--profile requires a profile name")
const home = profile < 0 ? join(homedir(), ".hermes") : join(homedir(), ".hermes", "profiles", Bun.argv[profile + 1]!)
const start = performance.now()
const dial = await attach(home, false)
const ws = new WebSocket(dial.url, dial.protocols)
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()
let id = 0
const timer = setTimeout(() => { ws.close(); process.exitCode = 1 }, 15000)
const request = (method: string, params: Record<string, unknown> = {}) => new Promise<unknown>((resolve, reject) => {
  const rid = String(++id)
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }))
})
ws.addEventListener("open", () => {
  if (ws.protocol !== "hermes-gateway-v1") throw new Error("missing hermes-gateway-v1 echo")
})
ws.addEventListener("message", async event => {
  const frame = JSON.parse(String(event.data))
  if (frame.id && pending.has(frame.id)) {
    const call = pending.get(frame.id)!
    pending.delete(frame.id)
    if (frame.error) call.reject(new Error(JSON.stringify(frame.error)))
    else call.resolve(frame.result)
  }
  if (frame.params?.type !== "gateway.ready") return
  try {
    const ready = performance.now() - start
    await request("client.capabilities", { server_requests: true })
    const describe = z.object({ profile_id: z.string(), capabilities: z.array(z.string()), session_create: z.object({ sources: z.array(z.string()) }) }).parse(await request("runtime.describe"))
    const sessions = z.object({ sessions: z.array(z.unknown()) }).parse(await request("session.list", { scope: "live", limit: 5 }))
    await request("gateway.ping")
    console.log(JSON.stringify({ profile: home, protocol: ws.protocol, ready_ms: ready, profile_id: describe.profile_id, capabilities: describe.capabilities, sources: describe.session_create.sources, live_count: sessions.sessions.length }, null, 2))
  } finally { clearTimeout(timer); ws.close() }
})
ws.addEventListener("error", () => { clearTimeout(timer); process.exitCode = 1; console.error("owner WebSocket failed") })
