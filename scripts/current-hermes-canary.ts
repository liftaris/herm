#!/usr/bin/env bun
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const args = Bun.argv.slice(2)

const arg = (name: string, fallback = "") => {
  const pos = args.indexOf(name)
  if (pos < 0) return fallback
  return args[pos + 1] || fallback
}

type Phase = "fetch_failed" | "generator_failed" | "schema_drift" | "compat_pass"

type Run = {
  code: number
  out: string
  err: string
}

const report = resolve(arg("--report", process.env.CURRENT_HERMES_REPORT || join(process.env.RUNNER_TEMP || ".ignore", "current-hermes-report")))
const base = resolve(arg("--base", "src/config/schema.ts"))
const repo = arg("--repo", process.env.HERMES_AGENT_REPO || "https://github.com/NousResearch/hermes-agent.git")
const ref = arg("--ref", process.env.HERMES_AGENT_REF || "main")
const given = arg("--root")
const root = given ? resolve(given) : join(process.env.RUNNER_TEMP || tmpdir(), `hermes-agent-current-${process.pid}`)
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
  const match = Bun.file(file).text().then(text => text.match(/^\/\/ Keys: (\d+)$/m)?.[1])
  return await match
}

const finish = async (phase: Phase, code: number, extra: Record<string, unknown> = {}) => {
  const data = {
    phase,
    repo,
    ref,
    root,
    base,
    upstream_sha: existsSync(join(report, "upstream-sha.txt")) ? (await Bun.file(join(report, "upstream-sha.txt")).text()).trim() : "unknown",
    base_keys: await keys(base),
    current_keys: await keys(schema),
    artifacts: {
      summary_json: "summary.json",
      summary_md: "summary.md",
      upstream_sha: "upstream-sha.txt",
      current_schema: "current-schema.ts",
      schema_diff: "schema.diff",
      fetch_stdout: "fetch.stdout",
      fetch_stderr: "fetch.stderr",
      gen_schema_stdout: "gen-schema.stdout",
      gen_schema_stderr: "gen-schema.stderr",
    },
    ...extra,
  }
  write("summary.json", `${JSON.stringify(data, null, 2)}\n`)
  write("summary.md", [
    `# Current Hermes compatibility canary`,
    ``,
    `- Phase: ${phase}`,
    `- Hermes ref: ${ref}`,
    `- Hermes SHA: ${data.upstream_sha}`,
    `- Base schema keys: ${data.base_keys ?? "unknown"}`,
    `- Current schema keys: ${data.current_keys ?? "unknown"}`,
    ``,
    phase === "compat_pass" ? "Generated schema matches the committed Herm schema." : "See the generated artifacts for the actionable failure details.",
    ``,
  ].join("\n"))
  process.exit(code)
}

if (!given) {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(dirname(root), { recursive: true })
  const init = run("git", ["init", "-q", root])
  const remote = init.code === 0 ? run("git", ["-C", root, "remote", "add", "origin", repo]) : init
  const fetch = remote.code === 0 ? run("git", ["-C", root, "fetch", "--depth=1", "origin", ref]) : remote
  write("fetch.stdout", [init.out, remote.out, fetch.out].join(""))
  write("fetch.stderr", [init.err, remote.err, fetch.err].join(""))
  if (fetch.code !== 0) await finish("fetch_failed", 1, { exit_code: fetch.code })
  const co = run("git", ["-C", root, "checkout", "--detach", "FETCH_HEAD"])
  write("checkout.stdout", co.out)
  write("checkout.stderr", co.err)
  if (co.code !== 0) await finish("fetch_failed", 1, { exit_code: co.code })
}

const sha = run("git", ["-C", root, "rev-parse", "HEAD"])
write("upstream-sha.txt", sha.code === 0 ? sha.out.trim() : "unknown")

const gen = run("bun", ["scripts/gen-schema.ts", "--out", schema], { ...process.env, HERMES_AGENT_ROOT: root })
write("gen-schema.stdout", gen.out)
write("gen-schema.stderr", gen.err)
if (gen.code !== 0) await finish("generator_failed", 1, { exit_code: gen.code })

const diff = run("diff", ["-u", base, schema])
write("schema.diff", diff.out)
if (diff.code === 0) await finish("compat_pass", 0)
if (diff.code === 1 && statSync(join(report, "schema.diff")).size > 0) await finish("schema_drift", 1)
await finish("generator_failed", 1, { exit_code: diff.code, diff_stderr: diff.err })
