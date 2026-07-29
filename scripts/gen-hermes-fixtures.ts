#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir, tmpdir } from "node:os"

const arg = (name: string) => {
  const pos = Bun.argv.indexOf(name)
  return pos >= 0 ? Bun.argv[pos + 1] : undefined
}

const root = arg("--agent-root") || process.env.HERMES_AGENT_ROOT
if (!root) {
  console.error("gen-hermes-fixtures: pass --agent-root or HERMES_AGENT_ROOT")
  process.exit(2)
}

const agent = resolve(root)
const config = join(agent, "hermes_cli", "config.py")
const server = join(agent, "tui_gateway", "server.py")
const entry = join(agent, "tui_gateway", "entry.py")
const ws = join(agent, "tui_gateway", "ws.py")
for (const file of [config, server, entry, ws]) {
  if (!existsSync(file)) {
    console.error(`gen-hermes-fixtures: missing ${file}`)
    process.exit(2)
  }
}

const real = join(homedir(), ".hermes")
if (process.env.HERMES_HOME === real) {
  console.error("gen-hermes-fixtures: refusing real HERMES_HOME; use a disposable HERMES_HOME")
  process.exit(2)
}

const tmp = join(tmpdir(), `herm-fixtures-${process.pid}`)
mkdirSync(tmp, { recursive: true })
process.env.HOME = join(tmp, "home")
process.env.HERMES_HOME = join(tmp, "hermes")
process.env.HERM_CONFIG_DIR = join(tmp, "config")
process.env.HERMES_CWD = join(tmp, "cwd")
process.env.TERMINAL_CWD = join(tmp, "cwd")
delete process.env.HERM_GATEWAY_URL
delete process.env.HERMES_TUI_GATEWAY_URL
mkdirSync(process.env.HOME, { recursive: true })
mkdirSync(process.env.HERMES_HOME, { recursive: true })
mkdirSync(process.env.HERM_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.HERMES_CWD, { recursive: true })

const sha = (() => {
  if (process.env.HERMES_AGENT_SHA) return process.env.HERMES_AGENT_SHA
  const proc = Bun.spawnSync(["git", "-C", agent, "rev-parse", "HEAD"])
  if (proc.exitCode === 0) return new TextDecoder().decode(proc.stdout).trim()
  return "unknown"
})()

const cmd = "bun scripts/gen-hermes-fixtures.ts --agent-root <producer-root>"
const target = resolve(arg("--out") || join(import.meta.dir, "..", "test", "fixtures", "hermes"))
const meta = (kind: string) => ({
  generated_by: "scripts/gen-hermes-fixtures.ts",
  generation_command: cmd,
  source_revision: sha,
  source_files: [
    "hermes_cli/config.py",
    "tui_gateway/server.py",
    "tui_gateway/entry.py",
    "tui_gateway/ws.py",
  ],
  kind,
})

const py = `
import ast, json, re, sys
config_path, server_path = sys.argv[1], sys.argv[2]
config = open(config_path, encoding="utf-8").read()
server = open(server_path, encoding="utf-8").read()
lines = config.splitlines()
start = next((i for i, line in enumerate(lines) if re.match(r"^DEFAULT_CONFIG\\s*=\\s*{", line)), None)
if start is None:
    raise RuntimeError("could not find DEFAULT_CONFIG")
depth, end = 0, start
for i in range(start, len(lines)):
    depth += lines[i].count("{") - lines[i].count("}")
    if depth == 0:
        end = i
        break
block = "\\n".join(lines[start:end + 1]).split("=", 1)[1].strip()
import operator
BIN = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
       ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv,
       ast.Mod: operator.mod, ast.Pow: operator.pow}
UNA = {ast.UAdd: operator.pos, ast.USub: operator.neg}
def ev(n):
    if isinstance(n, ast.Constant): return n.value
    if isinstance(n, ast.Dict): return {ev(k): ev(v) for k, v in zip(n.keys, n.values)}
    if isinstance(n, (ast.List, ast.Tuple)): return [ev(e) for e in n.elts]
    if isinstance(n, ast.Set): return sorted(ev(e) for e in n.elts)
    if isinstance(n, ast.BinOp) and type(n.op) in BIN: return BIN[type(n.op)](ev(n.left), ev(n.right))
    if isinstance(n, ast.UnaryOp) and type(n.op) in UNA: return UNA[type(n.op)](ev(n.operand))
    if isinstance(n, ast.Name) and n.id in ("True", "False", "None"):
        return {"True": True, "False": False, "None": None}[n.id]
    raise ValueError(f"unsupported node: {ast.dump(n)[:80]}")
def keys(node):
    out = []
    if isinstance(node, ast.Dict):
        for key in node.keys:
            if isinstance(key, ast.Constant) and isinstance(key.value, str):
                out.append(key.value)
    return out
tree = ast.parse(server)
fn = next((n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_session_info"), None)
if fn is None:
    raise RuntimeError("could not find _session_info")
seen = []
class Visitor(ast.NodeVisitor):
    def add(self, key):
        if isinstance(key, str) and key not in seen:
            seen.append(key)
    def visit_Assign(self, node):
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id == "info":
                for key in keys(node.value): self.add(key)
            if isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name) and target.value.id == "info":
                sl = target.slice
                if isinstance(sl, ast.Constant): self.add(sl.value)
        self.generic_visit(node)
    def visit_AnnAssign(self, node):
        target = node.target
        if isinstance(target, ast.Name) and target.id == "info":
            for key in keys(node.value): self.add(key)
        self.generic_visit(node)
Visitor().visit(fn)
approval = re.search(r"^_APPROVAL_MODES\\s*=\\s*frozenset\\((\\{.*?\\})\\)", server, re.M | re.S)
if not approval:
    raise RuntimeError("could not find _APPROVAL_MODES")
contract = re.search(r"^DESKTOP_BACKEND_CONTRACT\\s*=\\s*(\\d+)", server, re.M)
if not contract:
    raise RuntimeError("could not find DESKTOP_BACKEND_CONTRACT")
if '"jsonrpc": "2.0"' not in server or '"method": "event"' not in server or 'def _event_frame' not in server:
    raise RuntimeError("could not verify _event_frame envelope")
json.dump({
    "config": ev(ast.parse(block, mode="eval").body),
    "approval_modes": re.findall(r'"([^"]+)"', approval.group(1)),
    "session_keys": seen,
    "desktop_contract": int(contract.group(1)),
}, sys.stdout, sort_keys=True)
`

const proc = Bun.spawnSync(["python3", "-c", py, config, server])
if (proc.exitCode !== 0) {
  console.error("gen-hermes-fixtures: python extraction failed")
  console.error(new TextDecoder().decode(proc.stderr))
  rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}

const data = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
  config: Record<string, unknown>
  approval_modes: string[]
  session_keys: string[]
  desktop_contract: number
}

const entrySrc = readFileSync(entry, "utf8")
const wsSrc = readFileSync(ws, "utf8")
if (!entrySrc.includes('"type": "gateway.ready"') || !entrySrc.includes('"payload": {"skin": resolve_skin()}')) {
  console.error("gen-hermes-fixtures: could not verify stdio gateway.ready shape")
  process.exit(1)
}
if (!wsSrc.includes('"type": "gateway.ready"') || !wsSrc.includes('"payload": {"skin": server.resolve_skin()}')) {
  console.error("gen-hermes-fixtures: could not verify websocket gateway.ready shape")
  process.exit(1)
}

const sort = (val: unknown): unknown => {
  if (Array.isArray(val)) return val.map(sort)
  if (val && typeof val === "object") {
    const obj = val as Record<string, unknown>
    return Object.fromEntries(Object.keys(obj).sort().map(key => [key, sort(obj[key])]))
  }
  return val
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
  desktop_contract: data.desktop_contract,
  version: "0.0.0-fixture",
  release_date: "1970-01-01",
  update_behind: null,
  update_command: "",
  usage: { input: 11, output: 7, total: 18, context_used: 18, context_max: 1000, context_percent: 1.8, compressions: 0 },
  profile_name: "fixture-profile",
  mcp_servers: [],
  system_prompt: "fixture system prompt",
}

const info = Object.fromEntries(data.session_keys.map(key => [key, values[key] ?? null]))
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

const session = sort({ metadata: meta("session.info"), frame: frame("session.info", info) })
const events = sort({
  metadata: meta("gateway-events"),
  frames: [
    ready,
    frame("session.info", info),
    frame("status.update", { kind: "lifecycle", text: "fixture lifecycle" }),
    frame("tool.start", { tool_id: "tool-fixture-1", name: "read_file", context: "fixture.ts" }),
    frame("tool.complete", { tool_id: "tool-fixture-1", name: "read_file", summary: "fixture complete", duration_s: 0.25 }),
  ],
})
const cfg = sort({
  metadata: meta("config"),
  default_config: data.config,
  canonical: {
    approval_modes: data.approval_modes,
    approval_mode: (data.config.approvals as Record<string, unknown> | undefined)?.mode,
    gateway_timeout: (data.config.agent as Record<string, unknown> | undefined)?.gateway_timeout,
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
    `Source revision: ${sha}`,
    `Generation command: ${cmd}`,
    "",
    "These fixtures are generated by static source extraction from an explicit Hermes producer root.",
    "The generator sets disposable HOME/HERMES_HOME/HERM_CONFIG_DIR/HERMES_CWD values and does not import producer modules.",
    "",
  ].join("\n")],
])

if (Bun.argv.includes("--check")) {
  const stale = [...out].filter(([name, body]) => !existsSync(join(target, name)) || readFileSync(join(target, name), "utf8") !== body)
  if (stale.length === 0) {
    console.error(`gen-hermes-fixtures: ${target} is current (${sha})`)
    rmSync(tmp, { recursive: true, force: true })
    process.exit(0)
  }
  console.error(`gen-hermes-fixtures: ${target} is stale (${stale.map(([name]) => name).join(", ")})`)
  rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}

mkdirSync(target, { recursive: true })
for (const [name, body] of out) writeFileSync(join(target, name), body)
console.error(`gen-hermes-fixtures: wrote ${target} from ${agent}`)
rmSync(tmp, { recursive: true, force: true })
