// Profile discovery — direct filesystem reads, no gateway RPC needed.
//
// Profiles are inherently local: each is an isolated HERMES_HOME
// directory under `<root>/profiles/<name>/`, where <root> is the
// *default* hermes home (`~/.hermes` in the common case, even when
// herm itself is running under a named profile).
//
// `is_active` is NOT a property of a profile on disk — it depends on
// which HERMES_HOME the *gateway* was launched under, which may differ
// from herm's own process env. Callers pass the gateway-reported home
// (from `config.get key=profile`) and this module compares paths.
//
// All write ops (create/delete/rename/export/use) route through
// `shell.exec → hermes profile <verb>` in src/tabs/Agents.tsx so the
// authoritative CLI owns validation, skill seeding, wrapper aliases
// and gateway cleanup.

import { existsSync, readFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join, basename, dirname } from "node:path"
import { Database } from "bun:sqlite"
import { parse as parseYaml } from "yaml"
import type { Source } from "./hermes-home"

// Mirrors upstream `hermes_cli/profile_distribution.py` :: EnvRequirement.
// Describes a single env var a distribution expects to be set.
export type EnvRequirement = {
  name: string
  description: string
  required: boolean
  default: string | null
}

// Mirrors upstream `hermes_cli/profile_distribution.py` :: DistributionManifest.
// Contents of `<profile>/distribution.yaml` — present only for profiles
// installed via `hermes profile install`, absent for plain user profiles.
export type DistributionManifest = {
  name: string
  version: string
  description: string
  hermes_requires: string
  author: string
  license: string
  env_requires: EnvRequirement[]
  distribution_owned: string[]
  /** Upstream git URL / dir this distribution was pulled from. */
  source: string
  /** ISO-8601 UTC timestamp written on install / update. Empty for
   *  manifests that ship in an upstream repo. */
  installed_at: string
}

export type ProfileInfo = {
  name: string
  path: string
  is_default: boolean
  is_active: boolean
  is_sticky: boolean
  gateway_running: boolean
  model: string | null
  provider: string | null
  has_env: boolean
  skill_count: number
  has_alias: boolean
  soul_preview: string
  distribution: DistributionManifest | null
  sources: {
    dir: Source
    config: Source
    soul: Source
    env: Source
    distribution: Source
  }
}

const home = () => process.env.HOME || homedir()
const hermesHome = () => process.env.HERMES_HOME || join(home(), ".hermes")

// If HERMES_HOME is itself a named profile (…/profiles/<name>),
// the root is two levels up; otherwise HERMES_HOME is the root.
function root(): string {
  const hh = hermesHome()
  const parent = dirname(hh)
  return basename(parent) === "profiles" ? dirname(parent) : hh
}

// Derive a profile name from an absolute HERMES_HOME path. Accepts
// the gateway-reported home so "active" reflects the gateway's view,
// not herm's own process environment.
export function profileNameFrom(hh: string): string {
  const parent = dirname(hh)
  return basename(parent) === "profiles" ? basename(hh) : "default"
}

export function activeProfileName(): string {
  return profileNameFrom(hermesHome())
}

// `hermes profile use <name>` writes the sticky default here.
export function stickyDefault(): string | null {
  try {
    const raw = readFileSync(join(root(), "active_profile"), "utf-8").trim()
    return raw || null
  } catch { return null }
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function resolveProfileHome(name: string): string | null {
  if (name === "default") return root()
  if (!ID_RE.test(name)) return null
  const dir = join(root(), "profiles", name)
  return existsSync(dir) ? dir : null
}

function readModel(dir: string): [string | null, string | null] {
  try {
    const raw = readFileSync(join(dir, "config.yaml"), "utf-8")
    // Poor-man's YAML for two nested keys — avoids pulling the yaml lib
    // here (hermes-home.ts already owns that dependency for full parsing).
    const block = raw.split(/^model:\s*$/m)[1]?.split(/^\S/m)[0] ?? ""
    const m = block.match(/^\s+(?:default|model):\s*(.+)$/m)?.[1]?.trim()
          ?? raw.match(/^model:\s*(\S.+)$/m)?.[1]?.trim()
    const p = block.match(/^\s+provider:\s*(.+)$/m)?.[1]?.trim()
    const clean = (s?: string) => s?.replace(/^["']|["']$/g, "") ?? null
    return [clean(m), clean(p)]
  } catch { return [null, null] }
}

async function countSkills(dir: string): Promise<number> {
  const glob = new Bun.Glob("**/SKILL.md")
  let n = 0
  try {
    for await (const _ of glob.scan({ cwd: join(dir, "skills"), onlyFiles: true })) n++
  } catch { /* missing dir */ }
  return n
}

function gatewayRunning(dir: string): boolean {
  try {
    // Upstream moved to JSON pidfiles ({"pid":N,"kind":…}); older builds
    // wrote a bare integer. Accept either.
    const raw = readFileSync(join(dir, "gateway.pid"), "utf-8").trim()
    const pid = raw.startsWith("{") ? Number((JSON.parse(raw) as { pid?: number }).pid) : Number(raw)
    if (!Number.isFinite(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch { return false }
}

// Strip the leading H1 (everyone's SOUL.md starts `# <Name>\n\n`) and
// following blank lines so the preview shows actual content, not the
// filename repeated as a heading.
function soul(dir: string): string {
  try {
    const raw = readFileSync(join(dir, "SOUL.md"), "utf-8")
    const body = raw.replace(/^#[^\n]*\n+/, "").replace(/^\s+/, "")
    return body.slice(0, 400)
  } catch { return "" }
}

// Mirrors upstream `profile_distribution.py::read_manifest`. Returns
// null when the file is missing or unparseable — distribution presence
// is optional, it's never an error for a profile not to have one.
export function readDistributionManifest(dir: string): DistributionManifest | null {
  const path = join(dir, "distribution.yaml")
  if (!existsSync(path)) return null
  const data: unknown = (() => {
    try { return parseYaml(readFileSync(path, "utf-8")) }
    catch { return null }
  })()
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  const name = typeof d.name === "string" ? d.name.trim() : ""
  if (!name) return null
  const envRaw = Array.isArray(d.env_requires) ? d.env_requires : []
  const envs = envRaw.flatMap((e): EnvRequirement[] => {
    if (!e || typeof e !== "object") return []
    const r = e as Record<string, unknown>
    const n = typeof r.name === "string" ? r.name.trim() : ""
    if (!n) return []
    return [{
      name: n,
      description: typeof r.description === "string" ? r.description : "",
      required: r.required === undefined ? true : Boolean(r.required),
      default: typeof r.default === "string" ? r.default : null,
    }]
  })
  const ownedRaw = Array.isArray(d.distribution_owned) ? d.distribution_owned : []
  const owned = ownedRaw
    .map(p => typeof p === "string" ? p.trim().replace(/\/+$/, "") : "")
    .filter(p => p.length > 0)
  return {
    name,
    version: typeof d.version === "string" ? d.version : "0.1.0",
    description: typeof d.description === "string" ? d.description : "",
    hermes_requires: typeof d.hermes_requires === "string" ? d.hermes_requires : "",
    author: typeof d.author === "string" ? d.author : "",
    license: typeof d.license === "string" ? d.license : "",
    env_requires: envs,
    distribution_owned: owned,
    source: typeof d.source === "string" ? d.source : "",
    installed_at: typeof d.installed_at === "string" ? d.installed_at : "",
  }
}

const src = (file: string, label: string): Source =>
  ({ file, relative: file.replace(home() + "/", "~/"), label })

async function info(name: string, dir: string, active: string, sticky: string | null): Promise<ProfileInfo> {
  const [model, provider] = readModel(dir)
  const alias = join(home(), ".local", "bin", name)
  return {
    name,
    path: dir,
    is_default: name === "default",
    is_active: name === active,
    is_sticky: name === sticky,
    gateway_running: gatewayRunning(dir),
    model, provider,
    has_env: existsSync(join(dir, ".env")),
    skill_count: await countSkills(dir),
    has_alias: name !== "default" && existsSync(alias),
    soul_preview: soul(dir),
    distribution: readDistributionManifest(dir),
    sources: {
      dir: src(dir, dir.replace(home() + "/", "~/")),
      config: src(join(dir, "config.yaml"), "config.yaml"),
      soul: src(join(dir, "SOUL.md"), "SOUL.md"),
      env: src(join(dir, ".env"), ".env"),
      distribution: src(join(dir, "distribution.yaml"), "distribution.yaml"),
    },
  }
}

// `activeHome`: the gateway's HERMES_HOME (from `config.get key=profile`).
// Falls back to this process's env so the list is still usable offline.
export async function listProfiles(activeHome?: string): Promise<ProfileInfo[]> {
  const r = root()
  const active = profileNameFrom(activeHome ?? hermesHome())
  const sticky = stickyDefault()
  const jobs: Promise<ProfileInfo>[] = []
  if (existsSync(r)) jobs.push(info("default", r, active, sticky))
  const pr = join(r, "profiles")
  if (existsSync(pr)) {
    for (const e of await readdir(pr, { withFileTypes: true })) {
      if (!e.isDirectory() || !ID_RE.test(e.name)) continue
      jobs.push(info(e.name, join(pr, e.name), active, sticky))
    }
  }
  return Promise.all(jobs)
}

// Pre-flight UX only — the authoritative check is the CLI's own
// validation when `hermes profile create` runs. This just lets the
// dialog show inline error text before the user hits Enter.
export function validateName(name: string, existing: string[]): string | null {
  if (!ID_RE.test(name)) return "must match [a-z0-9][a-z0-9_-]{0,63}"
  if (existing.includes(name)) return "already exists"
  if (["hermes", "default", "test", "tmp", "root", "sudo"].includes(name)) return "reserved name"
  return null
}
//
// Counts that require opening that profile's state.db or reading its
// cron/jobs.json. Not part of listProfiles() — fetched on selection so
// a 10-profile list doesn't open 10 sqlite connections per refresh.

export type ProfilePrefs = {
  theme?: string
  eikon?: string
  keys: number
}

export type ProfileStats = {
  sessions: number | null
  messages: number | null
  crons: number | null
  /** That profile's herm/tui.json, when present. Null = no herm prefs
   *  written yet. Per-profile only when HERM_CONFIG_DIR is unset — an
   *  env override makes tui.json global and this read is best-effort. */
  prefs: ProfilePrefs | null
}

function readPrefs(dir: string): ProfilePrefs | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "herm", "tui.json"), "utf-8")) as {
      theme?: string; eikon?: string; eikonPath?: string; keys?: Record<string, string>
    }
    return {
      theme: raw.theme,
      eikon: raw.eikon ?? (raw.eikonPath ? basename(raw.eikonPath, ".eikon") : undefined),
      keys: raw.keys ? Object.keys(raw.keys).length : 0,
    }
  } catch { return null }
}

export async function profileStats(dir: string): Promise<ProfileStats> {
  let sessions: number | null = null
  let messages: number | null = null
  const dbPath = join(dir, "state.db")
  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readwrite: true, create: false })
      const r = db.query("SELECT COUNT(*) AS s FROM sessions WHERE message_count > 0")
        .get() as { s: number }
      const m = db.query("SELECT COALESCE(SUM(message_count), 0) AS m FROM sessions")
        .get() as { m: number }
      sessions = r.s
      messages = m.m
      db.close()
    } catch { /* schema drift or locked — leave null */ }
  }
  let crons: number | null = null
  try {
    const jobs = await Bun.file(join(dir, "cron", "jobs.json")).json() as unknown
    crons = Array.isArray(jobs) ? jobs.length
      : jobs && typeof jobs === "object" && Array.isArray((jobs as { jobs?: unknown[] }).jobs)
        ? (jobs as { jobs: unknown[] }).jobs.length
      : 0
  } catch { crons = existsSync(join(dir, "cron")) ? 0 : null }
  return { sessions, messages, crons, prefs: readPrefs(dir) }
}

export * as Profiles from "./hermes-profiles"
