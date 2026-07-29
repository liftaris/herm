#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const HOME = process.env.HOME!
const HERMES_HOME = process.env.HERMES_HOME || join(HOME, ".hermes")
const CANDIDATES = [
  process.env.HERMES_AGENT_ROOT,
  join(HERMES_HOME, "hermes-agent"),
  join(HOME, "Dev", "clones", "hermes-agent"),
].filter(Boolean) as string[]

const arg = (name: string) => {
  const pos = Bun.argv.indexOf(name)
  if (pos < 0) return ""
  const val = Bun.argv[pos + 1]
  if (!val || val.startsWith("--")) {
    console.error(`gen-capability-inventory: ${name} requires a path`)
    process.exit(2)
  }
  return resolve(val)
}

const target = arg("--out") || join(import.meta.dir, "..", "src", "app", "capabilityInventory.ts")
const overlay = arg("--overlay") || join(import.meta.dir, "..", "src", "app", "capabilityCoverage.ts")
const agent = arg("--agent") || CANDIDATES.find(p =>
  existsSync(join(p, "tui_gateway", "server.py")) && existsSync(join(p, "hermes_cli", "commands.py")),
)

if (!agent) {
  console.error("gen-capability-inventory: could not locate Hermes Agent under any of:", CANDIDATES)
  process.exit(1)
}

const sha = (() => {
  if (process.env.HERMES_AGENT_SHA) return process.env.HERMES_AGENT_SHA
  const p = Bun.spawnSync(["git", "-C", agent, "rev-parse", "HEAD"])
  if (p.exitCode !== 0) return "unknown"
  return new TextDecoder().decode(p.stdout).trim()
})()

const py = `
import ast, json, sys
from pathlib import Path
root = Path(${JSON.stringify(agent)})
server_path = root / "tui_gateway" / "server.py"
commands_path = root / "hermes_cli" / "commands.py"
server = server_path.read_text(encoding="utf-8")
commands = commands_path.read_text(encoding="utf-8")
stree = ast.parse(server, filename=str(server_path))
ctree = ast.parse(commands, filename=str(commands_path))
entries = []

def fail(msg):
    raise RuntimeError(msg)

def lit(node, where):
    try:
        return ast.literal_eval(node)
    except Exception as exc:
        fail(f"non-literal {where}: {exc}")

for node in ast.walk(stree):
    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        continue
    for dec in node.decorator_list:
        if not isinstance(dec, ast.Call) or not isinstance(dec.func, ast.Name):
            continue
        if dec.func.id not in {"method", "_projects_method"}:
            continue
        if not dec.args or not isinstance(dec.args[0], ast.Constant) or not isinstance(dec.args[0].value, str):
            if dec.func.id == "method" and getattr(dec.args[0], "id", "") == "name":
                continue
            fail(f"non-literal RPC decorator at {server_path}:{dec.lineno}")
        name = dec.args[0].value
        entries.append({
            "id": f"rpc:{name}",
            "kind": "rpc",
            "name": name,
            "source": f"tui_gateway/server.py:{dec.lineno}",
        })

for node in ast.walk(ctree):
    value = None
    if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "COMMAND_REGISTRY" for t in node.targets):
        value = node.value
    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "COMMAND_REGISTRY":
        value = node.value
    if value is None:
        continue
    if not isinstance(value, ast.List):
        fail("COMMAND_REGISTRY is not a literal list")
    for elt in value.elts:
        if not isinstance(elt, ast.Call) or getattr(elt.func, "id", "") != "CommandDef":
            fail(f"non-literal command registry entry at {commands_path}:{elt.lineno}")
        vals = [lit(a, f"CommandDef arg at line {elt.lineno}") for a in elt.args]
        kws = {kw.arg: lit(kw.value, f"CommandDef kw at line {elt.lineno}") for kw in elt.keywords}
        name = vals[0]
        entries.append({
            "id": f"slash:{name}",
            "kind": "slash",
            "name": name,
            "description": vals[1],
            "category": vals[2],
            "aliases": list(kws.get("aliases", ())),
            "argsHint": kws.get("args_hint", ""),
            "subcommands": list(kws.get("subcommands", ())),
            "cliOnly": bool(kws.get("cli_only", False)),
            "gatewayOnly": bool(kws.get("gateway_only", False)),
            "gatewayConfigGate": kws.get("gateway_config_gate"),
            "source": f"hermes_cli/commands.py:{elt.lineno}",
        })

for node in ast.walk(stree):
    if not isinstance(node, ast.AnnAssign) or not isinstance(node.target, ast.Name) or node.target.id != "_TUI_EXTRA":
        continue
    if not isinstance(node.value, ast.List):
        fail("_TUI_EXTRA is not a literal list")
    for elt in node.value.elts:
        vals = lit(elt, f"_TUI_EXTRA at line {elt.lineno}")
        name = vals[0].lstrip("/")
        entries.append({
            "id": f"slash-extra:{name}",
            "kind": "slash-extra",
            "name": name,
            "description": vals[1],
            "category": vals[2],
            "aliases": [],
            "argsHint": "",
            "subcommands": [],
            "cliOnly": False,
            "gatewayOnly": False,
            "gatewayConfigGate": None,
            "tuiExtra": True,
            "source": f"tui_gateway/server.py:{elt.lineno}",
        })

entries.extend([
    {
        "id": "slash-dynamic:quick_commands",
        "kind": "slash-dynamic",
        "name": "quick_commands",
        "source": "tui_gateway/server.py:11676",
        "description": "Profile quick commands discovered at runtime by commands.catalog.",
    },
    {
        "id": "slash-dynamic:skills",
        "kind": "slash-dynamic",
        "name": "skills",
        "source": "tui_gateway/server.py:11704",
        "description": "Skill commands discovered at runtime by commands.catalog.",
    },
])

seen = set()
out = []
for entry in sorted(entries, key=lambda x: x["id"]):
    if entry["id"] in seen:
        fail(f"duplicate producer id: {entry['id']}")
    seen.add(entry["id"])
    out.append(entry)
json.dump(out, sys.stdout, sort_keys=True)
`

const proc = Bun.spawnSync(["python3", "-c", py])
if (proc.exitCode !== 0) {
  console.error("gen-capability-inventory: python extraction failed")
  console.error(new TextDecoder().decode(proc.stderr))
  process.exit(1)
}

const entries = JSON.parse(new TextDecoder().decode(proc.stdout)) as Record<string, unknown>[]
const rows = entries.map(e => `  ${JSON.stringify(e.id)}: ${JSON.stringify(e)},`)
const body = [
  `// Generated by scripts/gen-capability-inventory.ts — do not edit by hand.`,
  `// Source: hermes-agent@${sha} tui_gateway/server.py + hermes_cli/commands.py`,
  `// Entries: ${entries.length}`,
  ``,
  `export type ProducerKind = "rpc" | "slash" | "slash-extra" | "slash-dynamic"`,
  ``,
  `export type ProducerEntry = {`,
  `  id: string`,
  `  kind: ProducerKind`,
  `  name: string`,
  `  source: string`,
  `  description?: string`,
  `  category?: string`,
  `  aliases?: string[]`,
  `  argsHint?: string`,
  `  subcommands?: string[]`,
  `  cliOnly?: boolean`,
  `  gatewayOnly?: boolean`,
  `  gatewayConfigGate?: string | null`,
  `  tuiExtra?: boolean`,
  `}`,
  ``,
  `export const CAPABILITY_INVENTORY = {`,
  ...rows,
  `} as const satisfies Record<string, ProducerEntry>`,
  ``,
  `export type ProducerId = keyof typeof CAPABILITY_INVENTORY`,
  `export const CAPABILITY_IDS = Object.keys(CAPABILITY_INVENTORY) as ProducerId[]`,
  ``,
].join("\n")

const fail = (label: string, rows: string[]) => {
  if (!rows.length) return false
  console.error(`gen-capability-inventory: ${label}`)
  for (const row of rows.slice(0, 40)) console.error(`  ${row}`)
  if (rows.length > 40) console.error(`  ... ${rows.length - 40} more`)
  return true
}

const checkCoverage = async () => {
  if (Bun.argv.includes("--inventory-only")) return false
  if (!existsSync(overlay)) {
    console.error(`gen-capability-inventory: missing overlay ${overlay}`)
    return true
  }
  const mod = await import(`${pathToFileURL(overlay).href}?t=${Date.now()}`)
  const cov = mod.CAPABILITY_COVERAGE as Record<string, { classification?: string; rationale?: string }> | undefined
  if (!cov) {
    console.error(`gen-capability-inventory: ${overlay} must export CAPABILITY_COVERAGE`)
    return true
  }
  const ids = entries.map(e => String(e.id))
  const set = new Set(ids)
  const keys = Object.keys(cov).sort()
  const classes = new Set([
    "covered.rpc",
    "covered.slash_gateway",
    "covered.local",
    "covered.plugin_api",
    "unsupported.intentional",
    "not_applicable.web_only",
    "not_applicable.internal",
    "missing",
  ])
  const missing = ids.filter(id => !cov[id])
  const stale = keys.filter(id => !set.has(id))
  const incomplete = keys.filter(id => !cov[id]?.classification || !cov[id]?.rationale?.trim())
  const invalid = keys.filter(id => cov[id]?.classification && !classes.has(cov[id].classification!))
  return [
    fail("unclassified producer ids", missing),
    fail("stale overlay ids", stale),
    fail("overlay entries missing classification or rationale", incomplete),
    fail("overlay entries with invalid classifications", invalid),
  ].some(Boolean)
}

if (Bun.argv.includes("--check")) {
  const stale = !existsSync(target) || readFileSync(target, "utf8") !== body
  if (stale) console.error(`gen-capability-inventory: ${target} is stale`)
  const bad = await checkCoverage()
  process.exit(stale || bad ? 1 : 0)
}

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, body)
const bad = await checkCoverage()
if (bad) process.exit(1)
console.error(`gen-capability-inventory: wrote ${target} (${entries.length} entries) from ${agent}`)
