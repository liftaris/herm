import { createConnection } from "node:net"
import { constants, lstatSync, openSync, fstatSync, readFileSync, closeSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { homedir } from "node:os"
import { createHash } from "node:crypto"
import { z } from "zod"

const identity = z.object({
  runtime_protocol: z.literal(1),
  instance_id: z.string().min(1),
  state: z.string(),
  capabilities: z.array(z.string()),
  api_origin: z.string(),
  served_profiles: z.array(z.object({ home: z.string(), profile_id: z.string().min(1) })),
})
const reply = z.object({ protocol: z.literal(1), id: z.literal(1), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() })

export type Owner = { home: string; control: string; profile: string; instance: string; url: string }
export type Dial = { url: string; protocols: string[] }

function profileHome() {
  return canonical(process.env.HERMES_HOME || join(homedir(), ".hermes"))
}

function canonical(home: string) {
  try { return realpathSync(home) }
  catch (err) { if (!missing(err)) throw err; return resolve(home) }
}

function privateNode(path: string, kind: "home" | "directory" | "socket") {
  const node = lstatSync(path)
  const valid = kind === "socket" ? node.isSocket() : node.isDirectory()
  if (!valid || node.uid !== process.getuid?.()) throw new Error(`unsafe gateway control path: ${path}`)
  if (node.mode & (kind === "home" ? 0o022 : 0o077))
    throw new Error(`unsafe gateway control permissions: ${path} mode ${(node.mode & 0o777).toString(8)}`)
}

function socketPath(home: string) {
  privateNode(home, "home")
  const direct = join(home, "gateway.sock")
  try { privateNode(direct, "socket"); return direct }
  catch (err) { if (!missing(err)) throw err }
  const pointer = join(home, "gateway.sock.path")
  const fd = openSync(pointer, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const node = fstatSync(fd)
    if (!node.isFile() || node.uid !== process.getuid?.() || node.mode & 0o077 || node.size > 4096)
      throw new Error("unsafe gateway control pointer")
    const target = readFileSync(fd, "utf8").trim()
    const hash = createHash("sha256").update(home).digest("hex").slice(0, 16)
    if (!isAbsolute(target) || basename(target) !== "control.sock" || basename(dirname(target)) !== `hermes-gw-${hash}`)
      throw new Error("invalid gateway control pointer")
    privateNode(dirname(target), "directory")
    privateNode(target, "socket")
    return target
  } finally { closeSync(fd) }
}

function missing(err: unknown) {
  return err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ECONNREFUSED")
}

async function control(home: string, verb: string, params?: Record<string, unknown>) {
  const path = socketPath(home)
  return new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(path)
    let buffer = ""
    const timer = setTimeout(() => socket.destroy(new Error(`gateway control timeout: ${verb}`)), 5000)
    socket.on("error", reject)
    socket.on("close", () => { clearTimeout(timer); reject(new Error(`gateway control closed: ${verb}`)) })
    socket.on("connect", () => socket.write(JSON.stringify({ protocol: 1, id: 1, verb, params }) + "\n"))
    socket.on("data", chunk => {
      buffer += chunk.toString()
      if (buffer.length > 524288) return socket.destroy(new Error("oversized gateway control response"))
      if (!buffer.includes("\n")) return
      try {
        const response = reply.parse(JSON.parse(buffer.split("\n")[0]!))
        if (!response.ok) reject(new Error(`gateway control ${verb}: ${response.error ?? "refused"}`))
        else resolve(response.result)
      }
      catch { reject(new Error(`invalid gateway control response: ${verb}`)) }
      socket.destroy()
    })
  })
}

function endpoint(raw: unknown, home: string, control: string): Owner {
  if (!raw || typeof raw !== "object" || !("runtime_protocol" in raw) || raw.runtime_protocol !== 1)
    throw new Error("missing runtime_protocol 1; update Hermes")
  if (!("state" in raw) || raw.state !== "ready") {
    const reason = "drain_reason" in raw && typeof raw.drain_reason === "string" ? `: ${raw.drain_reason}` : ""
    throw new Error(`gateway ${"state" in raw ? raw.state : "invalid_runtime_state"}${reason}`)
  }
  if (!("capabilities" in raw) || !Array.isArray(raw.capabilities) || !raw.capabilities.includes("session-authority-v1")) throw new Error("missing session-authority-v1; update Hermes")
  const data = identity.parse(raw)
  const profiles = data.served_profiles.filter(p => canonical(p.home) === home)
  if (profiles.length !== 1) throw new Error(`gateway profile_mismatch: ${home}`)
  const url = new URL(data.api_origin)
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (url.protocol !== "http:" || !url.port || !(host === "::1" || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(host))
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("invalid gateway loopback api_origin")
  url.protocol = "ws:"
  url.pathname = "/api/ws"
  return { home, control, profile: profiles[0]!.profile_id, instance: data.instance_id, url: url.toString() }
}

export async function discover(home = profileHome()): Promise<Owner | null> {
  const wanted = canonical(home)
  const roots = basename(dirname(wanted)) === "profiles" ? [wanted, dirname(dirname(wanted))] : [wanted]
  for (const root of roots) {
    try { return endpoint(await control(root, "identify"), wanted, root) }
    catch (err) { if (!missing(err)) throw err }
  }
  return null
}

export async function attach(home = profileHome(), ensure = true): Promise<Dial> {
  let owner = await discover(home)
  if (!owner && ensure) {
    const env = { ...process.env }
    for (const key of [
      "HERMES_MODEL", "HERMES_INFERENCE_MODEL", "HERMES_TUI_PROVIDER", "HERMES_INFERENCE_PROVIDER",
      "HERMES_TUI_TOOLSETS", "HERMES_TUI_SKILLS", "HERMES_CWD", "TERMINAL_CWD", "HERMES_YOLO",
      "HERMES_ACCEPT_HOOKS", "HERMES_TUI_CHECKPOINTS", "HERMES_TUI_PASS_SESSION_ID", "HERMES_KANBAN_BOARD",
      "HERMES_TUI_CLIENT_ENV", "HERMES_TUI_MAX_TURNS", "HERMES_YOLO_MODE", "HERMES_IGNORE_RULES",
      "HERMES_SAFE_MODE", "HERMES_IGNORE_USER_CONFIG",
    ]) delete env[key]
    const child = Bun.spawn([process.env.HERM_HERMES_BIN || "hermes", "gateway", "ensure", "--json", "--timeout", "30"], {
      env: { ...env, HERMES_HOME: canonical(home) }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 35_000,
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const verdict = z.object({ state: z.string(), reason_code: z.string().nullish(), detail: z.string().nullish() }).safeParse(
      (() => { try { return JSON.parse(stdout.trim()) } catch { return null } })(),
    )
    if (code !== 0 || !verdict.success || verdict.data.state !== "ready")
      throw new Error(verdict.success ? `gateway ${verdict.data.state}: ${[verdict.data.reason_code, verdict.data.detail].filter(Boolean).join(": ")}` : `gateway ensure exited ${code}: ${stderr.trim() || stdout.trim()}`)
    owner = await discover(home)
  }
  if (!owner) throw new Error("gateway owner unavailable")
  privateNode(owner.home, "home")
  const grant = z.object({ ticket: z.string().regex(/^[A-Za-z0-9_-]+$/), runtime_protocol: z.literal(1), instance_id: z.literal(owner.instance), profile_id: z.literal(owner.profile) })
    .safeParse(await control(owner.control, "session-ticket", { profile_id: owner.profile, instance_id: owner.instance, purpose: "interactive" }))
  if (!grant.success) throw new Error("invalid gateway ticket response")
  return { url: owner.url, protocols: ["hermes-gateway-v1", `hermes-gateway-ticket.${grant.data.ticket}`] }
}
