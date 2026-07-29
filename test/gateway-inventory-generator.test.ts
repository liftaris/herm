import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const script = join(import.meta.dir, "../scripts/gen-gateway-inventory.ts")

const run = async (root: string, args: string[]) => {
  const proc = Bun.spawn(["bun", script, ...args], {
    env: { ...process.env, HERMES_AGENT_ROOT: join(root, "agent"), HERMES_HOME: join(root, "home") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  return { code, err }
}

const prep = (server: string) => {
  const root = mkdtempSync(join(tmpdir(), "herm-inventory-"))
  const agent = join(root, "agent")
  mkdirSync(join(agent, "tui_gateway"), { recursive: true })
  mkdirSync(join(agent, "tools"), { recursive: true })
  writeFileSync(join(agent, "tui_gateway", "server.py"), server)
  writeFileSync(join(agent, "tui_gateway", "entry.py"), `write_json({"jsonrpc": "2.0", "method": "event", "params": {"type": "gateway.ready"}})\n`)
  writeFileSync(join(agent, "tui_gateway", "ws.py"), `await transport.write({"jsonrpc": "2.0", "method": "event", "params": {"type": "gateway.ready"}})\n`)
  writeFileSync(join(agent, "tools", "delegate_tool.py"), `_relay("subagent.start")\n_relay("subagent.complete")\n`)
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: agent })
  expect(git("init", "-q").exitCode).toBe(0)
  expect(git("add", ".").exitCode).toBe(0)
  expect(git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture").exitCode).toBe(0)
  const sha = new TextDecoder().decode(git("rev-parse", "HEAD").stdout).trim()
  return { root, sha }
}

const server = `_methods = {}

def write_json(obj):
    if obj.get("method") == "event":
        pass

def _emit(event, sid, payload=None):
    params = {"type": event, "session_id": sid}
    write_json({"jsonrpc": "2.0", "method": "event", "params": params})

def _block(event, sid, payload, timeout=300):
    _emit(event, sid, payload)

def method(name: str):
    def dec(fn):
        _methods[name] = fn
        return fn
    return dec

def handle_request(req):
    method = req.get("method")
    fn = _methods.get(method)
    return fn(None, {})

def _projects_method(name: str):
    def decorator(fn):
        @method(name)
        def handler(rid, params):
            return fn(rid, params, None, None)
        return handler
    return decorator

@method("session.create")
def _(rid, params):
    _emit("message.start", "s")
    _block("clarify.request", "s", {})

@_projects_method("projects.list")
def _(rid, params, pdb, conn):
    return {}
`

describe("gateway inventory generator", () => {
  test("emits deterministic inventory, provenance, and stale checks", async () => {
    const fix = prep(server)
    const one = join(fix.root, "one.ts")
    const two = join(fix.root, "two.ts")
    try {
      expect((await run(fix.root, ["--out", one])).code).toBe(0)
      expect((await run(fix.root, ["--out", two])).code).toBe(0)
      const text = await Bun.file(one).text()
      expect(await Bun.file(two).text()).toBe(text)
      expect(text).toContain(`sourceRevision": "${fix.sha}`)
      expect(text).toContain("static Python AST over explicit HERMES_AGENT_ROOT")
      expect(text).toContain('"session.create"')
      expect(text).toContain('"projects.list"')
      expect(text).toContain('"message.start"')
      expect(text).toContain('"gateway.ready"')
      expect(text).toContain('"additions"')
      expect((await run(fix.root, ["--check", "--out", one])).code).toBe(0)
      writeFileSync(one, `${text}\n// stale\n`)
      const stale = await run(fix.root, ["--check", "--out", one])
      expect(stale.code).toBe(1)
      expect(stale.err).toContain("is stale")
      expect(stale.err).toContain("additions:")
      expect(stale.err).toContain("removals:")
    } finally {
      rmSync(fix.root, { recursive: true, force: true })
    }
  })

  test("fails closed on duplicate methods", async () => {
    const fix = prep(`${server}\n@method("session.create")\ndef two(rid, params):\n    return {}\n`)
    try {
      const res = await run(fix.root, ["--out", join(fix.root, "out.ts")])
      expect(res.code).toBe(1)
      expect(res.err).toContain("duplicate RPC method")
    } finally {
      rmSync(fix.root, { recursive: true, force: true })
    }
  })

  test("fails closed on unknown dynamic event sources", async () => {
    const fix = prep(`${server}\ndef bad(name):\n    _emit(name, "s")\n`)
    try {
      const res = await run(fix.root, ["--out", join(fix.root, "out.ts")])
      expect(res.code).toBe(1)
      expect(res.err).toContain("event argument must be a literal")
    } finally {
      rmSync(fix.root, { recursive: true, force: true })
    }
  })

  test("fails closed when registry dispatch shape moves", async () => {
    const fix = prep(server.replace("fn = _methods.get(method)", "fn = routes.get(method)"))
    try {
      const res = await run(fix.root, ["--out", join(fix.root, "out.ts")])
      expect(res.code).toBe(1)
      expect(res.err).toContain("_methods.get(method)")
    } finally {
      rmSync(fix.root, { recursive: true, force: true })
    }
  })
})
