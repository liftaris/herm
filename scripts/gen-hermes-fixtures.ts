#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { gitSha, type Entry } from "./schema-source"
import { find } from "./hermes-source"

const arg = (name: string) => {
  const pos = Bun.argv.indexOf(name)
  return pos >= 0 ? Bun.argv[pos + 1] : undefined
}

const root = arg("--agent-root") || process.env.HERMES_AGENT_ROOT
if (!root) {
  console.error("gen-hermes-fixtures: pass --agent-root or HERMES_AGENT_ROOT")
  process.exit(2)
}

const agent = find(root)
const target = resolve(arg("--out") || join(import.meta.dir, "..", "test", "fixtures", "hermes"))
const source = resolve(arg("--manifest") || join(import.meta.dir, "..", "src", "compat", "hermes-manifest.ts"))
const schemaSource = resolve(arg("--schema") || join(import.meta.dir, "..", "src", "config", "schema.ts"))
const mod = await import(`${pathToFileURL(source).href}?t=${Date.now()}`) as {
  HERMES_MANIFEST?: {
    provenance: { sourceRevision: string }
    gateway: { events: { names: readonly string[] } }
    session: { keys: readonly string[]; desktopContract: number }
  }
}
const schema = await import(`${pathToFileURL(schemaSource).href}?t=${Date.now()}`) as {
  SCHEMA_SOURCE_REVISION?: string
  SCHEMA?: Record<string, Entry>
  APPROVAL_MODES?: readonly string[]
}
const manifest = mod.HERMES_MANIFEST
if (!manifest) {
  console.error(`gen-hermes-fixtures: ${source} must export HERMES_MANIFEST`)
  process.exit(2)
}
const revision = gitSha(agent)
if (!schema.SCHEMA || !schema.APPROVAL_MODES || !schema.SCHEMA_SOURCE_REVISION) {
  console.error(`gen-hermes-fixtures: ${schemaSource} must export schema provenance and values`)
  process.exit(2)
}
if (revision !== manifest.provenance.sourceRevision || revision !== schema.SCHEMA_SOURCE_REVISION) {
  console.error(`gen-hermes-fixtures: producer ${revision}, manifest ${manifest.provenance.sourceRevision}, and schema ${schema.SCHEMA_SOURCE_REVISION} must match`)
  process.exit(1)
}
const cmd = "bun scripts/gen-hermes-fixtures.ts --agent-root <producer-root>"
const meta = (kind: string, files: string[]) => ({
  generated_by: "scripts/gen-hermes-fixtures.ts",
  generation_command: cmd,
  source_revision: revision,
  source_files: files.sort(),
  producer_manifest: "src/compat/hermes-manifest.ts",
  kind,
})

const sort = (val: unknown): unknown => {
  if (Array.isArray(val)) return val.map(sort)
  if (!val || typeof val !== "object") return val
  const obj = val as Record<string, unknown>
  return Object.fromEntries(Object.keys(obj).sort().map(key => [key, sort(obj[key])]))
}

const sid = "session-fixture-0001"
const values: Record<string, unknown> = {
  model: "fixture-model",
  provider: "fixture-provider",
  reasoning_effort: "medium",
  service_tier: "standard",
  fast: false,
  yolo: false,
  approval_mode: "smart",
  tools: { core: ["read_file", "terminal"], kanban: ["kanban_show"] },
  skills: { devops: ["kanban-worker"], software: ["systematic-debugging"] },
  cwd: "/fixture/project",
  branch: "fixture-branch",
  project: { id: "p_fixture", slug: "fixture", name: "Fixture", primary_path: "/fixture/project" },
  personality: "default",
  running: false,
  title: "Fixture Session",
  stored_session_id: sid,
  desktop_contract: manifest.session.desktopContract,
  version: "0.0.0-fixture",
  release_date: "1970-01-01",
  update_behind: null,
  update_command: "",
  usage: { input: 11, output: 7, total: 18, context_used: 18, context_max: 1000, context_percent: 1.8, compressions: 0 },
  profile_name: "fixture-profile",
  mcp_servers: [],
  system_prompt: "fixture system prompt",
  credential_warning: null,
}

const missing = manifest.session.keys.filter(key => !(key in values))
if (missing.length) {
  console.error(`gen-hermes-fixtures: missing reviewed session values for ${missing.join(", ")}`)
  process.exit(1)
}
const fixtureEvents = ["gateway.ready", "session.info", "status.update", "tool.start", "tool.complete"]
const unknown = fixtureEvents.filter(name => !manifest.gateway.events.names.includes(name))
if (unknown.length) {
  console.error(`gen-hermes-fixtures: fixture events absent from producer manifest: ${unknown.join(", ")}`)
  process.exit(1)
}
const info = Object.fromEntries(manifest.session.keys.map(key => [key, values[key]]))
const frame = (type: string, payload?: unknown) => {
  const params: Record<string, unknown> = { type, session_id: sid }
  if (payload !== undefined) params.payload = payload
  return { jsonrpc: "2.0", method: "event", params }
}
const ready = {
  jsonrpc: "2.0",
  method: "event",
  params: { type: "gateway.ready", payload: { skin: { name: "fixture-skin" } } },
}
const session = sort({
  metadata: meta("session.info", ["tui_gateway/server.py"]),
  frame: frame("session.info", info),
})
const events = sort({
  metadata: meta("gateway-events", ["tui_gateway/entry.py", "tui_gateway/server.py", "tui_gateway/ws.py"]),
  frames: [
    ready,
    frame("session.info", info),
    frame("status.update", { kind: "lifecycle", text: "fixture lifecycle" }),
    frame("tool.start", { tool_id: "tool-fixture-1", name: "read_file", context: "fixture.ts" }),
    frame("tool.complete", { tool_id: "tool-fixture-1", name: "read_file", summary: "fixture complete", duration_s: 0.25 }),
  ],
})
const cfg = sort({
  metadata: meta("config", ["hermes_cli/config.py", "tui_gateway/server.py"]),
  canonical: {
    approval_modes: schema.APPROVAL_MODES,
    approval_mode: schema.SCHEMA["approvals.mode"]?.default,
    gateway_timeout: schema.SCHEMA["agent.gateway_timeout"]?.default,
  },
})
const text = (val: unknown) => `${JSON.stringify(val, null, 2)}\n`
const out = new Map([
  ["session-info.json", text(session)],
  ["gateway-events.json", text(events)],
  ["config.json", text(cfg)],
  ["README.md", [
    "# Hermes producer-derived compatibility fixtures",
    "",
    `Source revision: ${revision}`,
    `Generation command: ${cmd}`,
    "",
    "These fixtures use the shared static schema extractor and committed producer manifest for one explicit Hermes root.",
    "Complete producer inputs and capability provenance live in src/compat/hermes-manifest.ts.",
    "The generator never imports producer modules, starts the gateway, or reads Hermes user state.",
    "",
  ].join("\n")],
])

if (Bun.argv.includes("--check")) {
  const stale = [...out].filter(([name, body]) => !existsSync(join(target, name)) || readFileSync(join(target, name), "utf8") !== body)
  if (!stale.length) {
    console.error(`gen-hermes-fixtures: ${target} is current (${revision})`)
    process.exit(0)
  }
  console.error(`gen-hermes-fixtures: ${target} is stale (${stale.map(([name]) => name).join(", ")})`)
  process.exit(1)
}

mkdirSync(target, { recursive: true })
for (const [name, body] of out) writeFileSync(join(target, name), body)
console.error(`gen-hermes-fixtures: wrote ${target} from ${agent}`)
