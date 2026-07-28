#!/usr/bin/env bun
/**
 * gen-schema — derive src/config/schema.ts from the installed Hermes agent's
 * DEFAULT_CONFIG literal in hermes_cli/config.py.
 *
 * The literal is the de-facto schema: it names every key, gives a default
 * (which implies the type), and most leaves carry a #-comment doc either on
 * the preceding lines or trailing the value. We scrape all three.
 *
 * Python does the heavy lifting (ast.literal_eval + line-walk for docs) so
 * this script doesn't re-implement a Python parser. Output is a committed
 * .ts file — regenerate with `bun scripts/gen-schema.ts` after an agent pull.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"

const HOME = process.env.HOME!
const HERMES_HOME = process.env.HERMES_HOME || join(HOME, ".hermes")

// Same discovery order as the app (see src/context/gateway-client.ts):
// HERMES_AGENT_ROOT overrides; otherwise look under HERMES_HOME.
const CANDIDATES = [
  process.env.HERMES_AGENT_ROOT,
  join(HERMES_HOME, "hermes-agent"),
].filter(Boolean) as string[]

const agentRoot = CANDIDATES.find(p => existsSync(join(p, "hermes_cli", "config.py")))
if (!agentRoot) {
  console.error("gen-schema: could not locate hermes_cli/config.py under any of:", CANDIDATES)
  process.exit(1)
}
const configPy = join(agentRoot, "hermes_cli", "config.py")
const serverPy = join(agentRoot, "tui_gateway", "server.py")
const src = readFileSync(configPy, "utf8")
const tls = src.includes("ssl_ca_cert") && src.includes("ssl_verify")
const sha = (() => {
  if (process.env.HERMES_AGENT_SHA) return process.env.HERMES_AGENT_SHA
  const p = Bun.spawnSync(["git", "-C", agentRoot, "rev-parse", "HEAD"])
  return p.exitCode === 0 ? new TextDecoder().decode(p.stdout).trim() : "unknown"
})()
const sourceLabel = `hermes-agent@${sha} hermes_cli/config.py`

// ─── extract via python3 ─────────────────────────────────────────────

const py = `
import ast, json, re, sys

path = ${JSON.stringify(configPy)}
server_path = ${JSON.stringify(serverPy)}
with open(path, encoding="utf-8") as f:
    src = f.read()
with open(server_path, encoding="utf-8") as f:
    server = f.read()
lines = src.splitlines()

mode_match = re.search(r"^_APPROVAL_MODES\\s*=\\s*frozenset\\((\\{.*?\\})\\)", server, re.M | re.S)
if not mode_match:
    raise RuntimeError("could not find tui_gateway.server _APPROVAL_MODES")
approval_modes = re.findall(r'"([^"]+)"', mode_match.group(1))

# locate DEFAULT_CONFIG = { ... } by brace balance
start = next(i for i, l in enumerate(lines) if re.match(r"^DEFAULT_CONFIG\\s*=\\s*{", l))
depth, end = 0, start
for i in range(start, len(lines)):
    depth += lines[i].count("{") - lines[i].count("}")
    if depth == 0:
        end = i
        break
block = "\\n".join(lines[start:end + 1]).split("=", 1)[1].strip()
# ast.literal_eval rejects arithmetic (e.g. 24 * 7), which upstream uses
# in defaults. Safe-eval literals + constant arithmetic ourselves.
import operator
_BIN = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
        ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv,
        ast.Mod: operator.mod, ast.Pow: operator.pow}
_UNA = {ast.UAdd: operator.pos, ast.USub: operator.neg}
def ev(n):
    if isinstance(n, ast.Constant): return n.value
    if isinstance(n, ast.Dict): return {ev(k): ev(v) for k, v in zip(n.keys, n.values)}
    if isinstance(n, (ast.List, ast.Tuple)): return [ev(e) for e in n.elts]
    if isinstance(n, ast.Set): return {ev(e) for e in n.elts}
    if isinstance(n, ast.BinOp) and type(n.op) in _BIN: return _BIN[type(n.op)](ev(n.left), ev(n.right))
    if isinstance(n, ast.UnaryOp) and type(n.op) in _UNA: return _UNA[type(n.op)](ev(n.operand))
    if isinstance(n, ast.Name) and n.id in ("True", "False", "None"):
        return {"True": True, "False": False, "None": None}[n.id]
    raise ValueError(f"unsupported node: {ast.dump(n)[:80]}")
tree = ev(ast.parse(block, mode="eval").body)

# doc map: dotted-path -> text. Walk lines tracking key stack via indent+braces.
KEY = re.compile(r'^(\\s*)"([^"]+)"\\s*:\\s*(.*)$')
docs: dict[str, str] = {}
stack: list[tuple[int, str]] = []   # (indent, key)
pending: list[str] = []             # accumulated #-lines above next key
last_key: str = ""
last_ind: int = -1

def strip_hash(s: str) -> str:
    return re.sub(r"^#\\s?", "", s.strip())

for raw in lines[start + 1:end]:
    stripped = raw.strip()
    if not stripped:
        pending.clear(); continue
    if stripped.startswith("#"):
        ind = len(raw) - len(raw.lstrip())
        # deeper indent than the key just seen → trailing-comment continuation, not preceding doc
        if last_key and ind > last_ind:
            docs[last_key] = (docs.get(last_key, "") + " " + strip_hash(stripped)).strip()
        else:
            pending.append(strip_hash(stripped))
        continue
    m = KEY.match(raw)
    if not m:
        # closing brace or list item — drop stack frames shallower than this indent on '}'
        if stripped.startswith(("}", "},")):
            ind = len(raw) - len(raw.lstrip())
            while stack and stack[-1][0] >= ind:
                stack.pop()
        pending.clear(); continue
    ind, key, rest = len(m.group(1)), m.group(2), m.group(3)
    while stack and stack[-1][0] >= ind:
        stack.pop()
    dotted = ".".join([k for _, k in stack] + [key])
    # trailing same-line comment (outside string literal — crude but DEFAULT_CONFIG has no '#' inside strings)
    trail = ""
    h = rest.find("#")
    if h >= 0 and rest[:h].count('"') % 2 == 0:
        trail = strip_hash(rest[h:])
    doc = " ".join(pending).strip() or trail
    if doc:
        docs[dotted] = doc
    pending.clear()
    last_key, last_ind = dotted, ind
    # does this key open a nested dict literal?
    body = (rest[:h] if h >= 0 and trail else rest).rstrip(",").strip()
    if body.endswith("{") and not body.endswith("{}"):
        stack.append((ind, key))
        last_key = ""

def walk(node, prefix=""):
    for k, v in node.items():
        p = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict) and v:
            yield from walk(v, p)
        else:
            if isinstance(v, bool): t = "bool"
            elif isinstance(v, int): t = "int"
            elif isinstance(v, float): t = "float"
            elif isinstance(v, str): t = "str"
            elif isinstance(v, list): t = "list"
            elif isinstance(v, dict): t = "dict"
            elif v is None: t = "null"
            else: t = "str"
            yield p, {"type": t, "default": v, "doc": docs.get(p, "")}

out = dict(walk(tree))
json.dump({"source": path, "entries": out, "approval_modes": approval_modes}, sys.stdout)
`

const proc = Bun.spawnSync(["python3", "-c", py])
if (proc.exitCode !== 0) {
  console.error("gen-schema: python extraction failed")
  console.error(new TextDecoder().decode(proc.stderr))
  process.exit(1)
}
const extracted = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
  source: string
  entries: Record<string, { type: string; default: unknown; doc: string }>
  approval_modes: string[]
}

// ─── augment ─────────────────────────────────────────────────────────

/** Keys read by the agent that aren't in DEFAULT_CONFIG (user-adds-only). */
const EXTRA: Record<string, { type: string; default: unknown; doc: string }> = {
  custom_providers: { type: "dict", default: {}, doc: `OpenAI-compatible provider definitions keyed by name.${tls ? " Entries support ssl_ca_cert and ssl_verify." : ""}` },
  mcp_servers: { type: "dict", default: {}, doc: "MCP server definitions keyed by name." },
  fallback_model: { type: "dict", default: null, doc: "Fallback model (dict) or chain (list of dicts) for provider failover." },
  "agent.reasoning_effort": { type: "str", default: "", doc: "Reasoning effort for the main agent: none | minimal | low | medium | high | xhigh." },
  "agent.system_prompt": { type: "str", default: "", doc: "System-prompt override applied by the active personality." },
  custom_prompt: { type: "str", default: "", doc: "Ad-hoc system-prompt addendum set via /prompt." },
  provider: { type: "str", default: "", doc: "Default model provider." },
  "display.details_mode": { type: "str", default: "collapsed", doc: "Tool-progress section fold state: hidden | collapsed | expanded." },
  "display.thinking_mode": { type: "str", default: "collapsed", doc: "Reasoning display: collapsed | truncated | full." },
  "display.tool_progress": { type: "str", default: "all", doc: "Tool-progress verbosity: off | new | all | verbose." },
  "display.tui_compact": { type: "bool", default: false, doc: "Ink-TUI compact layout." },
  "display.tui_statusbar": { type: "str", default: "top", doc: "Ink-TUI statusbar placement: top | bottom | off." },
  "display.tui_mouse": { type: "bool", default: true, doc: "Ink-TUI mouse support." },
  "openrouter.min_coding_score": { type: "float", default: 0.65, doc: "Coding-score floor (0.0-1.0) for openrouter/pareto-code. Only applied when model is openrouter/pareto-code; ignored otherwise. Lower = cheaper model, higher = stronger coder." },
}

const RPC_LIVE = new Set([
  "model", "provider",
  "agent.service_tier", "agent.reasoning_effort",
  "display.show_reasoning", "display.tool_progress", "display.personality",
])

type Effect = "live" | "session" | "restart"
const effectOf = (key: string): Effect => {
  if (RPC_LIVE.has(key)) return "live"
  const root = key.split(".")[0]
  if (root === "terminal" || key === "toolsets" || key === "mcp_servers" || key === "skills.external_dirs")
    return "restart"
  if (root === "agent" || root === "auxiliary" || root === "memory" || root === "delegation")
    return "session"
  return "live"
}

type Entry = {
  type: "bool" | "int" | "float" | "str" | "list" | "dict" | "null"
  default: unknown
  doc: string
  group: string
  effect: Effect
}

const all: Record<string, Entry> = {}
for (const [k, v] of Object.entries({ ...extracted.entries, ...EXTRA })) {
  if (k.startsWith("_")) continue // _config_version etc.
  all[k] = {
    type: v.type as Entry["type"],
    default: v.default,
    doc: v.doc,
    group: k.includes(".") ? k.split(".")[0] : "general",
    effect: effectOf(k),
  }
}

if (tls && all.providers)
  all.providers.doc = "Provider definitions keyed by name. Custom/OpenAI-compatible entries support ssl_ca_cert and ssl_verify."

const keys = Object.keys(all).sort()

// ─── emit ────────────────────────────────────────────────────────────

const pos = Bun.argv.indexOf("--out")
if (pos >= 0 && !Bun.argv[pos + 1]) {
  console.error("gen-schema: --out requires a path")
  process.exit(2)
}
const target = pos >= 0
  ? resolve(Bun.argv[pos + 1])
  : join(import.meta.dir, "..", "src", "config", "schema.ts")
mkdirSync(dirname(target), { recursive: true })

const body = [
  `// Generated by scripts/gen-schema.ts — do not edit by hand.`,
  `// Source: ${sourceLabel}`,
  `// Keys: ${keys.length}`,
  ``,
  `export type ConfigType = "bool" | "int" | "float" | "str" | "list" | "dict" | "null"`,
  `export type ConfigEffect = "live" | "session" | "restart"`,
  ``,
  `export interface ConfigSchemaEntry {`,
  `  type: ConfigType`,
  `  default: unknown`,
  `  doc: string`,
  `  group: string`,
  `  effect: ConfigEffect`,
  `}`,
  ``,
  `export const SCHEMA: Record<string, ConfigSchemaEntry> = {`,
  ...keys.map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(all[k])},`),
  `}`,
  ``,
  `export const SCHEMA_KEYS = Object.keys(SCHEMA)`,
  ``,
  `export const APPROVAL_MODES = ${JSON.stringify(extracted.approval_modes)} as const`,
  ``,
].join("\n")

if (Bun.argv.includes("--check")) {
  if (existsSync(target) && readFileSync(target, "utf8") === body) {
    console.error(`gen-schema: ${target} is current (${keys.length} keys)`)
    process.exit(0)
  }
  console.error(`gen-schema: ${target} is stale`)
  process.exit(1)
}

writeFileSync(target, body)
console.error(`gen-schema: wrote ${target} (${keys.length} keys) from ${agentRoot}`)
