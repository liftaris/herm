#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { extract, find, type Producer } from "./hermes-source"
import { GATEWAY_EVENT_TYPES } from "../src/context/wire"
import { CAPABILITY_CLASSIFICATIONS } from "../src/app/capabilityCoverage"

const arg = (name: string) => {
  const pos = Bun.argv.indexOf(name)
  if (pos < 0) return ""
  const val = Bun.argv[pos + 1]
  if (!val || val.startsWith("--")) {
    console.error(`gen-hermes-manifest: ${name} requires a value`)
    process.exit(2)
  }
  return val
}

const input = arg("--agent") || process.env.HERMES_AGENT_ROOT
if (!input) {
  console.error("gen-hermes-manifest: pass --agent or HERMES_AGENT_ROOT")
  process.exit(2)
}
const root = find(input)
const target = resolve(arg("--out") || join(import.meta.dir, "..", "src", "compat", "hermes-manifest.ts"))
const paramsTarget = join(dirname(target), "hermes-params.ts")
const overlay = resolve(arg("--overlay") || join(import.meta.dir, "..", "src", "app", "capabilityCoverage.ts"))
const surface = extract(root)

const local = await (async () => {
  const glob = new Bun.Glob("src/**/*.{ts,tsx}")
  const files: string[] = []
  for await (const file of glob.scan({ cwd: join(import.meta.dir, "..") })) files.push(file)
  const calls = new Set<string>()
  const indirect = new Set<string>()
  for (const file of files.sort()) {
    const text = readFileSync(join(import.meta.dir, "..", file), "utf8")
    for (const row of text.matchAll(/\brequest(?:<[^>]+>)?\(\s*"([a-zA-Z0-9_.-]+)"/g)) calls.add(row[1])
    for (const row of text.matchAll(/\bmethod:\s*"([a-zA-Z0-9_.-]+)"/g)) indirect.add(row[1])
  }
  return { events: [...GATEWAY_EVENT_TYPES].sort(), methods: [...calls].sort(), indirect: [...indirect].sort() }
})()

const uniq = <T>(rows: T[]) => [...new Set(rows)].sort()
const score = (a: string, b: string) => {
  const aa = a.split(/[._-]/)
  const bb = b.split(/[._-]/)
  return aa.filter(part => bb.includes(part)).length / Math.max(aa.length, bb.length)
}
const renames = (additions: string[], removals: string[]) => additions.flatMap(to =>
  removals
    .map(from => ({ from, to, score: score(to, from) }))
    .filter(row => row.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3),
)
const diff = (producer: string[], consumer: string[]) => {
  const up = new Set(producer)
  const local = new Set(consumer)
  const additions = producer.filter(name => !local.has(name))
  const removals = consumer.filter(name => !up.has(name))
  return { additions, removals, likelyRenames: renames(additions, removals) }
}

// Hermes params models are extra="forbid": a key the contract does not declare answers 4000.
// The client injects the active session_id only where the method's params declare it, per wire.
const OPENRPC = "apps/shared/src/gateway-contract.openrpc.json"
type Rpc = { name: string; params: { schema: { $ref?: string; properties?: Record<string, unknown> } }[] }
const openrpc = (() => {
  const file = join(root, OPENRPC)
  if (!existsSync(file)) {
    console.error(`gen-hermes-manifest: ${OPENRPC} missing under ${root}`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(file, "utf8")) as {
    methods: Rpc[]
    "x-canonical-methods"?: Rpc[]
    components: { schemas: Record<string, { properties?: Record<string, unknown> }> }
  }
})()
const scoped = (rows: Rpc[]) => uniq(rows.filter(row => {
  const schema = row.params[0]?.schema
  const resolved = schema?.$ref ? openrpc.components.schemas[schema.$ref.split("/").pop()!] : schema
  return resolved?.properties && "session_id" in resolved.properties
}).map(row => row.name))

const methods = uniq(surface.methods.map(row => row.name))
const missing = methods.filter(name => !openrpc.methods.some(row => row.name === name))
if (missing.length) {
  console.error(`gen-hermes-manifest: ${OPENRPC} has no params contract for: ${missing.join(", ")}`)
  process.exit(1)
}
const events = uniq(surface.events.map(row => row.name))
const localMethods = uniq([...local.methods, ...local.indirect.filter(name => methods.includes(name))])
const commands = Object.fromEntries(surface.producers.filter(row => row.kind !== "rpc").map(row => {
  const { id, ...entry } = row
  return [id, entry]
})) as Record<string, Omit<Producer, "id">>
const ids = [...methods.map(name => `rpc:${name}`), ...Object.keys(commands)].sort()
const source = (rows: { name: string; path: string; line: number }[]) =>
  Object.fromEntries(rows.map(row => [row.name, { path: row.path, line: row.line }]))

const manifest = {
  provenance: {
    sourceRevision: surface.sha,
    sourceLabel: `hermes-agent@${surface.sha}`,
    extractor: "scripts/gen-hermes-manifest.ts",
    boundary: "static Python AST over explicit HERMES_AGENT_ROOT; no imports, gateway startup, HERMES_HOME reads, or producer execution",
    inputs: uniq([...surface.files, OPENRPC]),
  },
  gateway: {
    rpc: {
      methods,
      sessionScoped: scoped(openrpc.methods),
      sources: source(surface.methods),
      diff: diff(methods, localMethods),
    },
    canonical: {
      sessionScoped: scoped(openrpc["x-canonical-methods"] ?? []),
    },
    events: {
      names: events,
      sources: source(surface.events),
      diff: diff(events, local.events),
    },
  },
  session: {
    keys: surface.sessionKeys,
    desktopContract: surface.desktopContract,
  },
  commands,
} as const
const core = JSON.stringify({
  provenance: manifest.provenance,
  gateway: manifest.gateway,
  session: manifest.session,
}, null, 2).slice(0, -2)
const literal = [
  `${core},`,
  `  "commands": {`,
  ...Object.entries(commands).map(([id, row]) => `    ${JSON.stringify(id)}: ${JSON.stringify(row)},`),
  `  }`,
  `}`,
].join("\n")

const body = [
  `// Generated by scripts/gen-hermes-manifest.ts — do not edit by hand.`,
  `// Source: hermes-agent@${surface.sha}`,
  `// RPC methods: ${methods.length}; events: ${events.length}; commands: ${Object.keys(commands).length}`,
  ``,
  `export const HERMES_MANIFEST = ${literal} as const`,
  ``,
  `export type ProducerId = \`rpc:\${typeof HERMES_MANIFEST.gateway.rpc.methods[number]}\` | keyof typeof HERMES_MANIFEST.commands`,
  ``,
].join("\n")

const fail = (label: string, rows: string[]) => {
  if (!rows.length) return false
  console.error(`gen-hermes-manifest: ${label}`)
  for (const row of rows.slice(0, 40)) console.error(`  ${row}`)
  if (rows.length > 40) console.error(`  ... ${rows.length - 40} more`)
  return true
}

const coverage = async () => {
  if (Bun.argv.includes("--manifest-only")) return false
  if (!existsSync(overlay)) {
    console.error(`gen-hermes-manifest: missing overlay ${overlay}`)
    return true
  }
  const mod = await import(`${pathToFileURL(overlay).href}?t=${Date.now()}`)
  const cov = mod.CAPABILITY_COVERAGE as Record<string, { classification?: string; rationale?: string }> | undefined
  if (!cov) {
    console.error(`gen-hermes-manifest: ${overlay} must export CAPABILITY_COVERAGE`)
    return true
  }
  const set = new Set(ids)
  const keys = Object.keys(cov).sort()
  const classes = new Set<string>(CAPABILITY_CLASSIFICATIONS)
  const cli = Object.entries(commands)
    .filter(([id, row]) => row.cliOnly && cov[id]?.classification === "covered.slash_gateway")
    .map(([id]) => id)
  return [
    fail("unclassified producer ids", ids.filter(id => !cov[id])),
    fail("stale overlay ids", keys.filter(id => !set.has(id))),
    fail("overlay entries missing classification or rationale", keys.filter(id => !cov[id]?.classification || !cov[id]?.rationale?.trim())),
    fail("overlay entries with invalid classifications", keys.filter(id => cov[id]?.classification && !classes.has(cov[id].classification!))),
    fail("CLI-only commands classified as gateway slash coverage", cli),
  ].some(Boolean)
}

// The runtime client imports only this small module; the full manifest stays out of startup.
const params = [
  `// Generated by scripts/gen-hermes-manifest.ts — do not edit by hand.`,
  `// Source: hermes-agent@${surface.sha} ${OPENRPC}`,
  `// Methods whose params declare session_id; Hermes answers 4000 to any undeclared key.`,
  ``,
  `export const LEGACY_SESSION_SCOPED = ${JSON.stringify(manifest.gateway.rpc.sessionScoped, null, 2)} as const`,
  ``,
  `export const CANONICAL_SESSION_SCOPED = ${JSON.stringify(manifest.gateway.canonical.sessionScoped, null, 2)} as const`,
  ``,
].join("\n")

const outdated = (file: string, text: string) => !existsSync(file) || readFileSync(file, "utf8") !== text
const stale = [[target, body], [paramsTarget, params]].filter(([file, text]) => outdated(file, text)).map(([file]) => file)
const bad = await coverage()
if (Bun.argv.includes("--check")) {
  for (const file of stale) console.error(`gen-hermes-manifest: ${file} is stale`)
  process.exit(stale.length || bad ? 1 : 0)
}
if (bad) process.exit(1)
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, body)
writeFileSync(paramsTarget, params)
console.error(`gen-hermes-manifest: wrote ${relative(process.cwd(), target)} (${methods.length} RPC methods, ${events.length} events, ${Object.keys(commands).length} commands) from ${root}`)
