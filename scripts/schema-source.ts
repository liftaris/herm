import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export type Effect = "live" | "session" | "restart"
export type Entry = {
  type: "bool" | "int" | "float" | "str" | "list" | "dict" | "null"
  default: unknown
  doc: string
  group: string
  effect: Effect
}

type Raw = Record<string, { type: string; default: unknown; doc: string }>

export const home = () => process.env.HERMES_HOME || join(process.env.HOME!, ".hermes")

export const findRoot = (root?: string): string => {
  const candidates = [root, process.env.HERMES_AGENT_ROOT, join(home(), "hermes-agent")].filter(Boolean) as string[]
  const hit = candidates.find(p => existsSync(join(p, "hermes_cli", "config_defaults.py")))
  if (hit) return hit
  throw new Error(`could not locate hermes_cli/config_defaults.py under any of: ${candidates.join(", ")}`)
}

export const gitSha = (root: string, env = process.env.HERMES_AGENT_SHA): string => {
  if (env) return env
  const proc = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"])
  return proc.exitCode === 0 ? new TextDecoder().decode(proc.stdout).trim() : "unknown"
}

export const remote = (root: string): string => {
  const proc = Bun.spawnSync(["git", "-C", root, "config", "--get", "remote.origin.url"])
  const out = new TextDecoder().decode(proc.stdout).trim()
  return proc.exitCode === 0 && out ? out : "unknown"
}

const extract = (root: string) => {
  const config = join(root, "hermes_cli", "config_defaults.py")
  const server = join(root, "tui_gateway", "server.py")
  const providers = readFileSync(join(root, "hermes_cli", "config_providers.py"), "utf8")
  const tls = providers.includes("ssl_ca_cert") && providers.includes("ssl_verify")
  const py = `
import ast, json, re, sys
path = ${JSON.stringify(config)}
server_path = ${JSON.stringify(server)}
approval_path = ${JSON.stringify(join(root, "tools", "approval.py"))}
with open(path, encoding="utf-8") as f:
    src = f.read()
with open(server_path, encoding="utf-8") as f:
    server = f.read()
lines = src.splitlines()
mode_match = re.search(r"^_APPROVAL_MODES\\s*=\\s*frozenset\\((\\{.*?\\})\\)", server, re.M | re.S)
if mode_match:
    approval_modes = re.findall(r'"([^"]+)"', mode_match.group(1))
else:
    with open(approval_path, encoding="utf-8") as f:
        approval_src = f.read()
    valid_match = re.search(r"_VALID_MODES\\s*=\\s*\\((.*?)\\)", approval_src, re.S)
    if not valid_match:
        raise RuntimeError("could not find canonical approval modes")
    approval_modes = re.findall(r'"([^"]+)"', valid_match.group(1))
mod = ast.parse(src, filename=path)
at = next(i for i, n in enumerate(mod.body) if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "DEFAULT_CONFIG" for t in n.targets))
start, end = mod.body[at].lineno - 1, mod.body[at].end_lineno - 1
ns = {}
exec(compile(ast.Module(body=mod.body[:at + 1], type_ignores=[]), path, "exec"), ns)
tree = ns["DEFAULT_CONFIG"]
KEY = re.compile(r'^(\\s*)"([^"]+)"\\s*:\\s*(.*)$')
docs: dict[str, str] = {}
stack: list[tuple[int, str]] = []
pending: list[str] = []
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
        if last_key and ind > last_ind:
            docs[last_key] = (docs.get(last_key, "") + " " + strip_hash(stripped)).strip()
        else:
            pending.append(strip_hash(stripped))
        continue
    m = KEY.match(raw)
    if not m:
        if stripped.startswith(("}", "},")):
            ind = len(raw) - len(raw.lstrip())
            while stack and stack[-1][0] >= ind:
                stack.pop()
        pending.clear(); continue
    ind, key, rest = len(m.group(1)), m.group(2), m.group(3)
    while stack and stack[-1][0] >= ind:
        stack.pop()
    dotted = ".".join([k for _, k in stack] + [key])
    trail = ""
    h = rest.find("#")
    if h >= 0 and rest[:h].count('"') % 2 == 0:
        trail = strip_hash(rest[h:])
    doc = " ".join(pending).strip() or trail
    if doc:
        docs[dotted] = doc
    pending.clear()
    last_key, last_ind = dotted, ind
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
  if (proc.exitCode !== 0) throw new Error(`python extraction failed\n${new TextDecoder().decode(proc.stderr)}`)
  return { ...JSON.parse(new TextDecoder().decode(proc.stdout)) as { source: string; entries: Raw; approval_modes: string[] }, tls }
}

export const extras = (tls: boolean): Raw => ({
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
})

const RPC_LIVE = new Set([
  "model", "provider",
  "agent.service_tier", "agent.reasoning_effort",
  "display.show_reasoning", "display.tool_progress", "display.personality",
])

export const effectOf = (key: string): Effect => {
  if (RPC_LIVE.has(key)) return "live"
  const root = key.split(".")[0]
  if (root === "terminal" || key === "toolsets" || key === "mcp_servers" || key === "skills.external_dirs") return "restart"
  if (root === "agent" || root === "auxiliary" || root === "memory" || root === "delegation") return "session"
  return "live"
}

export const generate = (root = findRoot()) => {
  const sha = gitSha(root)
  const out = extract(root)
  const all: Record<string, Entry> = {}
  for (const [k, v] of Object.entries({ ...out.entries, ...extras(out.tls) })) {
    if (k.startsWith("_")) continue
    all[k] = {
      type: v.type as Entry["type"],
      default: v.default,
      doc: v.doc,
      group: k.includes(".") ? k.split(".")[0] : "general",
      effect: effectOf(k),
    }
  }
  if (out.tls && all.providers)
    all.providers.doc = "Provider definitions keyed by name. Custom/OpenAI-compatible entries support ssl_ca_cert and ssl_verify."
  const keys = Object.keys(all).sort()
  const body = [
    `// Generated by scripts/gen-schema.ts — do not edit by hand.`,
    `// Source: hermes-agent@${sha} hermes_cli/config_defaults.py`,
    `// Keys: ${keys.length}`,
    ``,
    `export type ConfigType = "bool" | "int" | "float" | "str" | "list" | "dict" | "null"`,
    `export type ConfigEffect = "live" | "session" | "restart"`,
    `export const SCHEMA_SOURCE_REVISION = ${JSON.stringify(sha)}`,
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
    `export const APPROVAL_MODES = ${JSON.stringify(out.approval_modes)} as const`,
    ``,
  ].join("\n")
  return { root, sha, source: out.source, entries: all, keys, approvalModes: out.approval_modes, body }
}

export const schemaTarget = (arg?: string) => arg ? resolve(arg) : join(import.meta.dir, "..", "src", "config", "schema.ts")

export const write = (target: string, body: string) => {
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, body)
}

export * as schemaSource from "./schema-source"
