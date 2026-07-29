import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const script = join(import.meta.dir, "../scripts/gen-hermes-manifest.ts")

const run = async (root: string, args: string[]) => {
  const proc = Bun.spawn(["bun", script, "--agent", join(root, "agent"), ...args], {
    env: { ...process.env, HERMES_HOME: join(root, "home") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  return { code, err }
}

const server = `_methods = {}
DESKTOP_BACKEND_CONTRACT = 4


def write_json(obj):
    if obj.get("method") == "event":
        pass


def _event_frame(event, sid, payload=None):
    params = {"type": event, "session_id": sid}
    return {"jsonrpc": "2.0", "method": "event", "params": params}


def _emit(event, sid, payload=None):
    write_json(_event_frame(event, sid, payload))


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


def _session_info(session):
    info = {"stored_session_id": "fixture", "desktop_contract": DESKTOP_BACKEND_CONTRACT}
    info["version"] = "fixture"
    return info


_TUI_EXTRA: list[tuple[str, str, str]] = [
    ("/sessions", "Switch sessions", "TUI"),
]


@method("session.create")
def one(rid, params):
    _emit("message.start", "s")
    _block("clarify.request", "s", {})


@_projects_method("projects.list")
def two(rid, params, pdb, conn):
    return {}
`

const commands = `from dataclasses import dataclass


@dataclass(frozen=True)
class CommandDef:
    name: str
    description: str
    category: str
    aliases: tuple[str, ...] = ()
    args_hint: str = ""
    subcommands: tuple[str, ...] = ()
    cli_only: bool = False
    gateway_only: bool = False
    gateway_config_gate: str | None = None


COMMAND_REGISTRY: list[CommandDef] = [
    CommandDef("sessions", "Browse sessions", "Session"),
]
`

const prep = (source = server) => {
  const root = mkdtempSync(join(tmpdir(), "herm-manifest-"))
  const agent = join(root, "agent")
  mkdirSync(join(agent, "tui_gateway"), { recursive: true })
  mkdirSync(join(agent, "hermes_cli"), { recursive: true })
  mkdirSync(join(agent, "tools"), { recursive: true })
  writeFileSync(join(agent, "tui_gateway", "server.py"), source)
  writeFileSync(join(agent, "tui_gateway", "entry.py"), `write_json({"jsonrpc": "2.0", "method": "event", "params": {"type": "gateway.ready", "payload": {"skin": resolve_skin()}}})\n`)
  writeFileSync(join(agent, "tui_gateway", "ws.py"), `await transport.write({"jsonrpc": "2.0", "method": "event", "params": {"type": "gateway.ready", "payload": {"skin": server.resolve_skin()}}})\n`)
  writeFileSync(join(agent, "hermes_cli", "commands.py"), commands)
  writeFileSync(join(agent, "tools", "delegate_tool.py"), `_relay("subagent.start")\n_relay("subagent.complete")\n`)
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: agent })
  expect(git("init", "-q").exitCode).toBe(0)
  expect(git("add", ".").exitCode).toBe(0)
  expect(git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture").exitCode).toBe(0)
  return root
}

const overlay = (root: string, rows: Record<string, { classification: string; rationale: string }>) => {
  const file = join(root, "overlay.ts")
  writeFileSync(file, `export const CAPABILITY_COVERAGE = ${JSON.stringify(rows)}\n`)
  return file
}

const rows = {
  "rpc:projects.list": { classification: "missing", rationale: "fixture gap" },
  "rpc:session.create": { classification: "covered.rpc", rationale: "structured session RPC" },
  "slash:sessions": { classification: "covered.local", rationale: "tab route" },
  "slash-extra:sessions": { classification: "covered.local", rationale: "TUI extra" },
  "slash-dynamic:quick_commands": { classification: "covered.slash_gateway", rationale: "runtime class" },
  "slash-dynamic:skills": { classification: "covered.slash_gateway", rationale: "runtime class" },
}

describe("Hermes producer manifest generator", () => {
  test("refuses ambient producer discovery", async () => {
    const env: Record<string, string | undefined> = { ...process.env }
    delete env.HERMES_AGENT_ROOT
    const proc = Bun.spawn(["bun", script], { env, stdout: "pipe", stderr: "pipe" })
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(code).toBe(2)
    expect(err).toContain("--agent")
  })

  test("emits one deterministic manifest for gateway, session, and command surfaces", async () => {
    const root = prep()
    const one = join(root, "one.ts")
    const two = join(root, "two.ts")
    const policy = overlay(root, rows)
    try {
      expect((await run(root, ["--out", one, "--overlay", policy])).code).toBe(0)
      expect((await run(root, ["--out", two, "--overlay", policy])).code).toBe(0)
      const text = await Bun.file(one).text()
      expect(await Bun.file(two).text()).toBe(text)
      expect(text).toContain("static Python AST over explicit HERMES_AGENT_ROOT")
      expect(text).toContain('"session.create"')
      expect(text).toContain('"projects.list"')
      expect(text).toContain('"message.start"')
      expect(text).toContain('"slash:sessions"')
      expect(text).toContain('"desktopContract": 4')
      expect(text).toContain('"stored_session_id"')
      expect((await run(root, ["--check", "--out", one, "--overlay", policy])).code).toBe(0)
      writeFileSync(one, `${text}\n// stale\n`)
      const stale = await run(root, ["--check", "--out", one, "--overlay", policy])
      expect(stale.code).toBe(1)
      expect(stale.err).toContain("is stale")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails when a producer capability lacks policy", async () => {
    const root = prep()
    const missing: Partial<typeof rows> = { ...rows }
    delete missing["slash-extra:sessions"]
    try {
      const res = await run(root, ["--out", join(root, "out.ts"), "--overlay", overlay(root, missing)])
      expect(res.code).toBe(1)
      expect(res.err).toContain("unclassified producer ids")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails closed on duplicate RPC methods", async () => {
    const root = prep(`${server}\n@method("session.create")\ndef duplicate(rid, params):\n    return {}\n`)
    try {
      const res = await run(root, ["--out", join(root, "out.ts"), "--overlay", overlay(root, rows)])
      expect(res.code).toBe(1)
      expect(res.err).toContain("duplicate RPC method")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails closed on unknown dynamic event sources", async () => {
    const root = prep(`${server}\ndef bad(name):\n    _emit(name, "s")\n`)
    try {
      const res = await run(root, ["--out", join(root, "out.ts"), "--overlay", overlay(root, rows)])
      expect(res.code).toBe(1)
      expect(res.err).toContain("event argument must be a literal")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails closed when registry dispatch shape moves", async () => {
    const root = prep(server.replace("fn = _methods.get(method)", "fn = routes.get(method)"))
    try {
      const res = await run(root, ["--out", join(root, "out.ts"), "--overlay", overlay(root, rows)])
      expect(res.code).toBe(1)
      expect(res.err).toContain("_methods.get(method)")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
