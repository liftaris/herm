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

const server = `DESKTOP_BACKEND_CONTRACT = 4


def _session_info(session):
    info = {"stored_session_id": "fixture", "desktop_contract": DESKTOP_BACKEND_CONTRACT}
    info["version"] = "fixture"
    return info
`

const registry = `def method(name, *, params, result): ...\ndef event(name, payload=None, *, doc=""): ...\n`

const contracts = `method("session.create", params=None, result=None)
method("projects.list", params=None, result=None)
event("message.start")
event("gateway.ready")
for _name, _doc in (("subagent.start", "start"), ("subagent.complete", "done")):
    event(_name, doc=_doc)
`

const discovery = `_TUI_EXTRA: list[tuple[str, str, str]] = [
    ("/sessions", "Switch sessions", "TUI"),
]
`

const commands = `from dataclasses import dataclass
from hermes_constants import STYLES


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
    CommandDef("indicator", "Pick a style", "Configuration", args_hint=f"[{'|'.join(STYLES)}]", subcommands=STYLES),
]
`

const prep = (files: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "herm-manifest-"))
  const agent = join(root, "agent")
  mkdirSync(join(agent, "tui_gateway", "contracts"), { recursive: true })
  mkdirSync(join(agent, "hermes_cli"), { recursive: true })
  const all: Record<string, string> = {
    "hermes_constants.py": `STYLES: tuple[str, ...] = ("ascii", "emoji")\n`,
    "hermes_cli/commands.py": commands,
    "tui_gateway/server.py": server,
    "tui_gateway/command_discovery.py": discovery,
    "tui_gateway/contracts/registry.py": registry,
    "tui_gateway/contracts/sessions.py": contracts,
    "tui_gateway/entry.py": `write_json({"jsonrpc": "2.0", "method": "event", "params": {"type": "gateway.ready", "payload": {"skin": resolve_skin()}}})\n`,
    "tui_gateway/ws.py": `await transport.write({"jsonrpc": "2.0", "method": "event", "params": {"type": "gateway.ready", "payload": {"skin": server.resolve_skin()}}})\n`,
    ...files,
  }
  for (const [name, body] of Object.entries(all)) writeFileSync(join(agent, name), body)
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
  "slash:indicator": { classification: "unsupported.intentional", rationale: "fixture" },
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
      expect(text).toContain('"subagent.complete"')
      expect(text).toContain('"slash:sessions"')
      expect(text).toContain('"argsHint":"[ascii|emoji]"')
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
    const root = prep({ "tui_gateway/contracts/more.py": `method("session.create", params=None, result=None)\n` })
    try {
      const res = await run(root, ["--out", join(root, "out.ts"), "--overlay", overlay(root, rows)])
      expect(res.code).toBe(1)
      expect(res.err).toContain("duplicate RPC method")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails closed on non-literal contract names", async () => {
    const root = prep({ "tui_gateway/contracts/more.py": `event(some_name)\n` })
    try {
      const res = await run(root, ["--out", join(root, "out.ts"), "--overlay", overlay(root, rows)])
      expect(res.code).toBe(1)
      expect(res.err).toContain("contract name must be a literal")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails closed when the contract registry shape moves", async () => {
    const root = prep({ "tui_gateway/contracts/registry.py": `def declare(name): ...\n` })
    try {
      const res = await run(root, ["--out", join(root, "out.ts"), "--overlay", overlay(root, rows)])
      expect(res.code).toBe(1)
      expect(res.err).toContain("missing def method")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
