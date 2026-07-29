import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const schema = join(root, "scripts/gen-schema.ts")
const canary = join(root, "scripts/current-hermes-canary.ts")

const writeAgent = (dir: string, turns: number) => {
  mkdirSync(join(dir, "hermes_cli"), { recursive: true })
  mkdirSync(join(dir, "tui_gateway"), { recursive: true })
  writeFileSync(join(dir, "hermes_cli/config.py"), `DEFAULT_CONFIG = {
    "agent": {
        # Maximum turns in one session.
        "max_turns": ${turns},
    },
}
`)
  writeFileSync(join(dir, "tui_gateway/server.py"), `_APPROVAL_MODES = frozenset({"manual", "smart", "off"})\n`)
}

const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd })

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "herm-current-canary-"))
  const agent = join(dir, "agent")
  writeAgent(agent, 90)
  expect(git(agent, "init", "-q").exitCode).toBe(0)
  expect(git(agent, "add", "hermes_cli/config.py", "tui_gateway/server.py").exitCode).toBe(0)
  expect(git(agent, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture").exitCode).toBe(0)
  return { dir, agent }
}

const run = async (args: string[]) => {
  const proc = Bun.spawn(["bun", canary, ...args], {
    cwd: root,
    env: { ...process.env, HERMES_HOME: join(tmpdir(), "herm-current-canary-home") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  return { code, err }
}

const base = (agent: string, file: string) => {
  const proc = Bun.spawnSync(["bun", schema, "--out", file], {
    cwd: root,
    env: { ...process.env, HERMES_AGENT_ROOT: agent, HERMES_HOME: join(tmpdir(), "herm-current-canary-base") },
  })
  expect(proc.exitCode).toBe(0)
}

describe("current Hermes canary", () => {
  test("reports compat_pass without rewriting the committed schema artifact", async () => {
    const f = fixture()
    const file = join(f.dir, "base.ts")
    const report = join(f.dir, "report")
    base(f.agent, file)

    try {
      const proc = await run(["--root", f.agent, "--base", file, "--report", report])
      expect(proc.code).toBe(0)
      const data = await Bun.file(join(report, "summary.json")).json()
      expect(data.phase).toBe("compat_pass")
      expect(await Bun.file(join(report, "schema.diff")).text()).toBe("")
      expect(await Bun.file(file).text()).not.toContain("schema_drift")
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

  test("classifies upstream schema drift as an actionable artifact", async () => {
    const f = fixture()
    const file = join(f.dir, "base.ts")
    const report = join(f.dir, "report")
    base(f.agent, file)
    writeAgent(f.agent, 120)

    try {
      const proc = await run(["--root", f.agent, "--base", file, "--report", report])
      expect(proc.code).toBe(1)
      const data = await Bun.file(join(report, "summary.json")).json()
      expect(data.phase).toBe("schema_drift")
      expect(await Bun.file(join(report, "schema.diff")).text()).toContain("max_turns")
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

  test("classifies generator failures with report logs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herm-current-canary-bad-"))
    const agent = join(dir, "agent")
    const report = join(dir, "report")
    mkdirSync(agent, { recursive: true })

    try {
      const proc = await run(["--root", agent, "--report", report])
      expect(proc.code).toBe(1)
      const data = await Bun.file(join(report, "summary.json")).json()
      expect(data.phase).toBe("generator_failed")
      expect(await Bun.file(join(report, "gen-schema.stderr")).text()).toContain("could not locate")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
