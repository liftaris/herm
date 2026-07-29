import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const script = join(import.meta.dir, "../scripts/gen-capability-inventory.ts")

const run = async (root: string, args: string[]) => {
  const proc = Bun.spawn(["bun", script, "--agent", join(root, "agent"), ...args], {
    env: { ...process.env, HERMES_HOME: join(root, "home") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  return { code, err }
}

const seed = (root: string) => {
  const agent = join(root, "agent")
  mkdirSync(join(agent, "tui_gateway"), { recursive: true })
  mkdirSync(join(agent, "hermes_cli"), { recursive: true })
  writeFileSync(join(agent, "tui_gateway", "server.py"), `def method(name):
    def deco(fn):
        return fn
    return deco

@method("session.create")
def one(rid, params):
    return {}

_TUI_EXTRA: list[tuple[str, str, str]] = [
    ("/sessions", "Switch sessions", "TUI"),
]
`)
  writeFileSync(join(agent, "hermes_cli", "commands.py"), `from dataclasses import dataclass

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
`)
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: agent })
  expect(git("init", "-q").exitCode).toBe(0)
  expect(git("add", "tui_gateway/server.py", "hermes_cli/commands.py").exitCode).toBe(0)
  expect(git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture").exitCode).toBe(0)
}

const overlay = (root: string, rows: Record<string, { classification: string; rationale: string }>) => {
  const file = join(root, "overlay.ts")
  writeFileSync(file, `export const CAPABILITY_COVERAGE = ${JSON.stringify(rows)}\n`)
  return file
}

describe("capability inventory generator", () => {
  test("emits deterministic producer facts and validates the policy overlay", async () => {
    const root = mkdtempSync(join(tmpdir(), "herm-capability-"))
    const out = join(root, "inventory.ts")
    const rows = {
      "rpc:session.create": { classification: "covered.rpc", rationale: "structured session RPC" },
      "slash:sessions": { classification: "covered.local", rationale: "tab route" },
      "slash-extra:sessions": { classification: "covered.local", rationale: "TUI extra pair" },
      "slash-dynamic:quick_commands": { classification: "covered.slash_gateway", rationale: "runtime class" },
      "slash-dynamic:skills": { classification: "covered.slash_gateway", rationale: "runtime class" },
    }

    try {
      seed(root)
      const good = overlay(root, rows)
      expect((await run(root, ["--out", out, "--overlay", good])).code).toBe(0)
      const first = await Bun.file(out).text()
      expect(first).toContain('"rpc:session.create"')
      expect(first).toContain('"slash:sessions"')
      expect(first).toContain('"slash-extra:sessions"')
      expect((await run(root, ["--check", "--out", out, "--overlay", good])).code).toBe(0)

      writeFileSync(out, `${first}\n// stale\n`)
      const stale = await run(root, ["--check", "--out", out, "--overlay", good])
      expect(stale.code).toBe(1)
      expect(stale.err).toContain("is stale")

      const miss: Partial<typeof rows> = { ...rows }
      delete miss["slash-extra:sessions"]
      const missing = overlay(root, miss)
      const bad = await run(root, ["--check", "--out", out, "--overlay", missing])
      expect(bad.code).toBe(1)
      expect(bad.err).toContain("unclassified producer ids")

      const extra = overlay(root, { ...rows, "rpc:gone": { classification: "missing", rationale: "stale" } })
      const st = await run(root, ["--check", "--out", out, "--overlay", extra])
      expect(st.code).toBe(1)
      expect(st.err).toContain("stale overlay ids")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
