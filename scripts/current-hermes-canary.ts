#!/usr/bin/env bun
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const args = Bun.argv.slice(2)
const arg = (name: string, fallback = "") => {
  const pos = args.indexOf(name)
  return pos < 0 ? fallback : args[pos + 1] || fallback
}

type Phase = "fetch_failed" | "generator_failed" | "schema_drift" | "compat_pass"
type Run = { code: number; out: string; err: string }
type Contract = { repository: string; pinned: string; current: string }

const contract = await Bun.file(join(import.meta.dir, "..", "hermes.contract.json")).json() as Contract
const report = resolve(arg("--report", process.env.CURRENT_HERMES_REPORT || join(process.env.RUNNER_TEMP || ".ignore", "current-hermes-report")))
const base = resolve(arg("--base", "src/config/schema.ts"))
const repo = arg("--repo", process.env.HERMES_AGENT_REPO || contract.repository)
const ref = arg("--ref", process.env.HERMES_AGENT_REF || contract.current)
const pin = arg("--pin", process.env.HERMES_AGENT_PIN || contract.pinned)
const given = arg("--root")
const pinGiven = arg("--pinned-root")
const tmp = process.env.RUNNER_TEMP || tmpdir()
const root = resolve(given || join(tmp, `hermes-agent-current-${process.pid}`))
const pinned = resolve(pinGiven || join(tmp, `hermes-agent-pinned-${process.pid}`))
const schema = join(report, "current-schema.ts")

mkdirSync(report, { recursive: true })
const write = (file: string, text: string) => writeFileSync(join(report, file), text)
const run = (cmd: string, vals: string[], env = process.env): Run => {
  const proc = Bun.spawnSync([cmd, ...vals], { env, stdout: "pipe", stderr: "pipe" })
  return {
    code: proc.exitCode,
    out: new TextDecoder().decode(proc.stdout),
    err: new TextDecoder().decode(proc.stderr),
  }
}
const keys = async (file: string) => {
  if (!existsSync(file)) return null
  return (await Bun.file(file).text()).match(/^\/\/ Keys: (\d+)$/m)?.[1] ?? null
}
const checkout = (dir: string, revision: string, prefix: string) => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dirname(dir), { recursive: true })
  const init = run("git", ["init", "-q", dir])
  const remote = init.code === 0 ? run("git", ["-C", dir, "remote", "add", "origin", repo]) : init
  const fetch = remote.code === 0 ? run("git", ["-C", dir, "fetch", "--depth=1", "origin", revision]) : remote
  write(`${prefix}-fetch.stdout`, [init.out, remote.out, fetch.out].join(""))
  write(`${prefix}-fetch.stderr`, [init.err, remote.err, fetch.err].join(""))
  if (fetch.code !== 0) return fetch
  const co = run("git", ["-C", dir, "checkout", "--detach", "FETCH_HEAD"])
  write(`${prefix}-checkout.stdout`, co.out)
  write(`${prefix}-checkout.stderr`, co.err)
  return co
}

const finish = async (phase: Phase, code: number, extra: Record<string, unknown> = {}) => {
  const data = {
    phase,
    repo,
    ref,
    pin,
    root,
    pinned_root: pinned,
    base,
    upstream_sha: existsSync(join(report, "upstream-sha.txt")) ? (await Bun.file(join(report, "upstream-sha.txt")).text()).trim() : "unknown",
    pinned_sha: existsSync(join(report, "pinned-sha.txt")) ? (await Bun.file(join(report, "pinned-sha.txt")).text()).trim() : "unknown",
    base_keys: await keys(base),
    current_keys: await keys(schema),
    artifacts: {
      summary_json: "summary.json",
      summary_md: "summary.md",
      upstream_sha: "upstream-sha.txt",
      pinned_sha: "pinned-sha.txt",
      current_schema: "current-schema.ts",
      schema_diff: "schema.diff",
      config_drift: "config-drift.json",
      config_drift_stderr: "config-drift.stderr",
      fetch_stdout: "current-fetch.stdout",
      fetch_stderr: "current-fetch.stderr",
    },
    ...extra,
  }
  write("summary.json", `${JSON.stringify(data, null, 2)}\n`)
  write("summary.md", [
    "# Current Hermes compatibility canary",
    "",
    `- Phase: ${phase}`,
    `- Hermes ref: ${ref}`,
    `- Hermes SHA: ${data.upstream_sha}`,
    `- Pinned SHA: ${data.pinned_sha}`,
    `- Base schema keys: ${data.base_keys ?? "unknown"}`,
    `- Current schema keys: ${data.current_keys ?? "unknown"}`,
    "",
    phase === "compat_pass" ? "Generated schema matches the committed Herm schema." : "See the semantic and raw schema artifacts for actionable drift details.",
    "",
  ].join("\n"))
  process.exit(code)
}

if (!given) {
  const current = checkout(root, ref, "current")
  if (current.code !== 0) await finish("fetch_failed", 1, { exit_code: current.code, source: "current" })
}
if (!pinGiven) {
  const source = checkout(pinned, pin, "pinned")
  if (source.code !== 0) await finish("fetch_failed", 1, { exit_code: source.code, source: "pinned" })
}

const currentSha = run("git", ["-C", root, "rev-parse", "HEAD"])
const pinnedSha = run("git", ["-C", pinned, "rev-parse", "HEAD"])
write("upstream-sha.txt", currentSha.code === 0 ? currentSha.out.trim() : "unknown")
write("pinned-sha.txt", pinnedSha.code === 0 ? pinnedSha.out.trim() : "unknown")

const drift = run("bun", [
  "scripts/config-drift.ts",
  "--baseline", base,
  "--pinned-root", pinned,
  "--current-root", root,
  "--current-schema-out", schema,
  "--current-ref", ref,
  "--json",
  "--warn-current",
])
write("config-drift.json", drift.out)
write("config-drift.stderr", drift.err)
if (drift.code !== 0) await finish("generator_failed", 1, { config_drift_exit_code: drift.code })
try { JSON.parse(drift.out) }
catch { await finish("generator_failed", 1, { config_drift_exit_code: drift.code, config_drift_error: "invalid JSON report" }) }

const diff = run("diff", ["-u", base, schema])
write("schema.diff", diff.out)
write("schema-diff.stderr", diff.err)
const extra = { config_drift_exit_code: drift.code }
if (diff.code === 0) await finish("compat_pass", 0, extra)
if (diff.code === 1 && statSync(join(report, "schema.diff")).size > 0) await finish("schema_drift", 1, extra)
await finish("generator_failed", 1, { ...extra, exit_code: diff.code, diff_stderr: diff.err })
