import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const script = join(import.meta.dir, "../scripts/gen-schema.ts")

const run = async (root: string, args: string[]) => {
  const proc = Bun.spawn(["bun", script, ...args], {
    env: { ...process.env, HERMES_AGENT_ROOT: join(root, "agent"), HERMES_HOME: join(root, "home") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  return { code, err }
}

describe("config schema generator", () => {
  test("emits deterministic output and detects stale artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "herm-schema-"))
    const dir = join(root, "agent", "hermes_cli")
    const gw = join(root, "agent", "tui_gateway")
    const one = join(root, "one.ts")
    const two = join(root, "two.ts")
    mkdirSync(dir, { recursive: true })
    mkdirSync(gw, { recursive: true })
    writeFileSync(join(dir, "config.py"), `DEFAULT_CONFIG = {
    "_config_version": 1,
    "agent": {
        # Maximum turns in one session.
        "max_turns": 90,
    },
    "compression": {
        "threshold": 0.8,
    },
}
`)
    writeFileSync(join(gw, "server.py"), `_APPROVAL_MODES = frozenset({"manual", "smart", "off"})\n`)
    const agent = join(root, "agent")
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: agent })
    expect(git("init", "-q").exitCode).toBe(0)
    expect(git("add", "hermes_cli/config.py", "tui_gateway/server.py").exitCode).toBe(0)
    expect(git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture").exitCode).toBe(0)
    const sha = new TextDecoder().decode(git("rev-parse", "HEAD").stdout).trim()

    try {
      expect((await run(root, ["--out", one])).code).toBe(0)
      expect((await run(root, ["--out", two])).code).toBe(0)
      const first = await Bun.file(one).text()
      expect(await Bun.file(two).text()).toBe(first)
      expect(first).toContain('"agent.max_turns"')
      expect(first).toContain('"compression.threshold"')
      expect(first).not.toContain('"_config_version"')
      expect(first).toContain(`Source: hermes-agent@${sha} hermes_cli/config.py`)
      expect(first).toContain('export const APPROVAL_MODES = ["manual","smart","off"] as const')
      expect((await run(root, ["--check", "--out", one])).code).toBe(0)

      writeFileSync(one, `${first}\n// stale\n`)
      const stale = await run(root, ["--check", "--out", one])
      expect(stale.code).toBe(1)
      expect(stale.err).toContain("is stale")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
