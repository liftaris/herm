import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const gen = join(import.meta.dir, "../scripts/gen-schema.ts")
const drift = join(import.meta.dir, "../scripts/config-drift.ts")

const agent = (root: string, body: string, modes = ["manual", "smart", "off"]) => {
  const dir = join(root, "hermes_cli")
  const gw = join(root, "tui_gateway")
  mkdirSync(dir, { recursive: true })
  mkdirSync(gw, { recursive: true })
  writeFileSync(join(dir, "config.py"), body)
  writeFileSync(join(gw, "server.py"), `_APPROVAL_MODES = frozenset(${JSON.stringify(modes).replace("[", "{").replace("]", "}")})\n`)
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root })
  expect(git("init", "-q").exitCode).toBe(0)
  expect(git("add", "hermes_cli/config.py", "tui_gateway/server.py").exitCode).toBe(0)
  expect(git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture").exitCode).toBe(0)
  return new TextDecoder().decode(git("rev-parse", "HEAD").stdout).trim()
}

const run = async (cmd: string[], env: Record<string, string>) => {
  const proc = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, out, err }
}

describe("config drift report", () => {
  test("separates reproducible pinned drift from current-upstream semantic drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "herm-drift-"))
    const pinned = join(root, "pinned")
    const current = join(root, "current")
    const base = join(root, "schema.ts")
    mkdirSync(pinned)
    mkdirSync(current)
    const body = `DEFAULT_CONFIG = {
    "agent": { "max_turns": 90 },
    "approvals": { "mode": "smart" },
    "compression": { "threshold": 0.8 },
    "logging": { "level": "INFO" },
}
`
    const next = `DEFAULT_CONFIG = {
    "agent": { "max_turns": 120 },
    "approvals": { "mode": "smart" },
    "cron": { "model": "" },
    "logging": { "level": "INFO" },
}
`
    const pinnedSha = agent(pinned, body)
    const currentSha = agent(current, next, ["manual", "smart", "off", "auto"])

    try {
      expect((await run(["bun", gen, "--out", base], { HERMES_AGENT_ROOT: pinned, HERMES_HOME: join(root, "home") })).code).toBe(0)
      const json = await run(["bun", drift, "--json", "--baseline", base, "--pinned-root", pinned, "--current-root", current], {
        HERMES_HOME: join(root, "home"),
        SOURCE_DATE_EPOCH: "0",
      })
      expect(json.code).toBe(1)
      const report = JSON.parse(json.out)
      expect(report.schema_version).toBe(1)
      expect(report.sources.pinned.reproducible).toBe(true)
      expect(report.sources.pinned.sha).toBe(pinnedSha)
      expect(report.sources.current_upstream.reproducible).toBe(false)
      expect(report.sources.current_upstream.resolved_sha).toBe(currentSha)
      expect(report.summary.pinned.status).toBe("clean")
      expect(report.summary.current_upstream).toMatchObject({ status: "drift", added: 1, removed: 1, changed: 1 })
      expect(report.comparisons.keys.added).toEqual(["cron.model"])
      expect(report.comparisons.keys.removed).toEqual(["compression.threshold"])
      expect(report.comparisons.entries.changed).toEqual([{ key: "agent.max_turns", fields: ["default"] }])
      expect(report.comparisons.approval_modes.current_upstream.status).toBe("drift")
      expect(report.findings.map((f: { category: string }) => f.category)).toEqual(expect.arrayContaining([
        "added_key", "removed_key", "default_changed", "enum_changed", "review_required",
      ]))
      expect(report.findings.find((f: { key?: string; category: string }) => f.key === "cron.model" && f.category === "review_required").classification.requires_review).toBe(true)

      const human = await run(["bun", drift, "--baseline", base, "--pinned-root", pinned, "--current-root", current], {
        HERMES_HOME: join(root, "home"),
        SOURCE_DATE_EPOCH: "0",
      })
      expect(human.code).toBe(1)
      expect(human.out).toContain(`Pinned schema: clean (${pinnedSha})`)
      expect(human.out).toContain(`Current upstream: drift (${currentSha})`)
      expect(human.out).toContain("keys +1 / -1 / Δ1")
      expect(human.out).toContain("approval modes: drift")
      expect(human.out).toContain("review needed: cron.model")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
