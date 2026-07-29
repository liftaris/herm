#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join, relative, resolve } from "path"

const HOME = process.env.HOME!
const HERMES_HOME = process.env.HERMES_HOME || join(HOME, ".hermes")
const CANDIDATES = [
  process.env.HERMES_AGENT_ROOT,
  join(HERMES_HOME, "hermes-agent"),
].filter(Boolean) as string[]

const root = CANDIDATES.find(p => existsSync(join(p, "tui_gateway", "server.py")))
if (!root) {
  console.error("gen-gateway-inventory: could not locate tui_gateway/server.py under any of:", CANDIDATES)
  process.exit(1)
}

const pos = Bun.argv.indexOf("--out")
if (pos >= 0 && !Bun.argv[pos + 1]) {
  console.error("gen-gateway-inventory: --out requires a path")
  process.exit(2)
}
const target = pos >= 0
  ? resolve(Bun.argv[pos + 1])
  : join(import.meta.dir, "..", "src", "compat", "gateway-inventory.ts")

const sha = (() => {
  if (process.env.HERMES_AGENT_SHA) return process.env.HERMES_AGENT_SHA
  const proc = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"])
  return proc.exitCode === 0 ? new TextDecoder().decode(proc.stdout).trim() : "unknown"
})()

const local = await (async () => {
  const glob = new Bun.Glob("src/**/*.{ts,tsx}")
  const files: string[] = []
  for await (const file of glob.scan({ cwd: join(import.meta.dir, "..") })) files.push(file)
  const events = new Set<string>()
  const calls = new Set<string>()
  const wire = readFileSync(join(import.meta.dir, "..", "src", "context", "wire.ts"), "utf8")
  const part = wire.slice(wire.indexOf("export type GatewayEvent"), wire.indexOf("export type SubagentPayload"))
  for (const m of part.matchAll(/type:\s*"([a-zA-Z0-9_.-]+)"/g)) events.add(m[1])
  for (const file of files.sort()) {
    const text = readFileSync(join(import.meta.dir, "..", file), "utf8")
    for (const m of text.matchAll(/\brequest(?:<[^>]+>)?\(\s*"([a-zA-Z0-9_.-]+)"/g)) calls.add(m[1])
  }
  return { events: [...events].sort(), methods: [...calls].sort() }
})()

const py = String.raw`
import ast, json, os, sys
from pathlib import Path

root = Path(${JSON.stringify(root)})
rel = lambda p: str(Path(p).relative_to(root))
failures = []
files = []
methods = []
events = []
dynamic = []
seen_methods = {}
seen_events = set()

want = [
    "tui_gateway/server.py",
    "tui_gateway/ws.py",
    "tui_gateway/entry.py",
    "tools/delegate_tool.py",
]
want += [str(p.relative_to(root)) for p in sorted((root / "tools").glob("*.py")) if p.exists()]
want = sorted(set(want))

class Visitor(ast.NodeVisitor):
    def __init__(self, path, tree):
        self.path = path
        self.tree = tree
        self.stack = []
    def visit_FunctionDef(self, node):
        self._fn(node)
    def visit_AsyncFunctionDef(self, node):
        self._fn(node)
    def _fn(self, node):
        if self.path == "tui_gateway/server.py":
            for dec in node.decorator_list:
                if name(dec) == "method" and "_projects_method" not in self.stack:
                    val = lit(dec.args[0]) if dec.args else None
                    if val is None:
                        failures.append(f"{self.path}:{node.lineno}: @method decorator must use a literal string")
                    elif val in seen_methods:
                        failures.append(f"{self.path}:{node.lineno}: duplicate RPC method {val!r}; first seen at {seen_methods[val]}")
                    else:
                        seen_methods[val] = f"{self.path}:{node.lineno}"
                        methods.append({"name": val, "path": self.path, "line": node.lineno, "kind": "decorator"})
                if name(dec) == "_projects_method":
                    val = lit(dec.args[0]) if dec.args else None
                    if val is None:
                        failures.append(f"{self.path}:{node.lineno}: @_projects_method decorator must use a literal string")
                    elif val in seen_methods:
                        failures.append(f"{self.path}:{node.lineno}: duplicate RPC method {val!r}; first seen at {seen_methods[val]}")
                    else:
                        seen_methods[val] = f"{self.path}:{node.lineno}"
                        methods.append({"name": val, "path": self.path, "line": node.lineno, "kind": "projects-wrapper"})
        self.stack.append(node.name)
        for child in node.body:
            self.visit(child)
        self.stack.pop()
    def visit_Call(self, node):
        nm = name(node.func)
        val = lit(node.args[0]) if node.args else None
        if self.path == "tui_gateway/server.py" and nm in {"_emit", "_block", "_broadcast_global_event", "_voice_emit"}:
            if self.stack and self.stack[-1] in {"_emit", "_block", "_broadcast_global_event", "_voice_emit", "_event_frame"}:
                pass
            elif val is not None:
                add_event(val, self.path, node.lineno, nm)
                if nm == "_block" and derives_expire(self.tree):
                    add_event(val.removesuffix(".request") + ".expire", self.path, node.lineno, "derived-expire")
            elif covered_dynamic(nm, node, self.path, self.stack):
                dynamic.append({"path": self.path, "line": node.lineno, "call": nm, "rule": "delegate-subagent-relay"})
            else:
                failures.append(f"{self.path}:{node.lineno}: {nm} event argument must be a literal or covered rule")
        if nm == "emit" and attr_base(node.func) == "desktop_ui":
            if val is not None:
                add_event(val, self.path, node.lineno, "desktop_ui.emit")
            else:
                failures.append(f"{self.path}:{node.lineno}: desktop_ui.emit event argument must be a literal")
        if val and val.startswith("subagent.") and self.path == "tools/delegate_tool.py" and val != "subagent.text":
            add_event(val, self.path, node.lineno, "delegate-tool")
        self.generic_visit(node)
    def visit_Dict(self, node):
        ev = direct_event(node)
        if ev is not None:
            add_event(ev, self.path, node.lineno, "jsonrpc-event-frame")
        self.generic_visit(node)

def name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Call):
        return name(node.func)
    return ""

def attr_base(node):
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
        return node.value.id
    return ""

def lit(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None

def add_event(val, path, line, kind):
    key = (val, path, line, kind)
    if key in seen_events:
        return
    seen_events.add(key)
    events.append({"name": val, "path": path, "line": line, "kind": kind})

def has_call(node, pred):
    return any(isinstance(n, ast.Call) and pred(n) for n in ast.walk(node))

def has_assign(node, pred):
    return any(isinstance(n, (ast.Assign, ast.AnnAssign)) and pred(n) for n in ast.walk(node))

def sub_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Constant):
        return node.value
    return None

def validate_server(tree, path):
    fns = {n.name: n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    method = fns.get("method")
    if method is None:
        failures.append(f"{path}: missing def method(name)")
    elif not has_assign(method, lambda n: any(isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) and t.value.id == "_methods" and sub_name(t.slice) == "name" for t in getattr(n, "targets", [getattr(n, "target", None)]))):
        failures.append(f"{path}:{method.lineno}: method() no longer registers _methods[name]")
    handle = fns.get("handle_request")
    if handle is None:
        failures.append(f"{path}: missing handle_request")
    elif not has_call(handle, lambda n: isinstance(n.func, ast.Attribute) and n.func.attr == "get" and isinstance(n.func.value, ast.Name) and n.func.value.id == "_methods" and n.args and isinstance(n.args[0], ast.Name) and n.args[0].id == "method"):
        failures.append(f"{path}:{handle.lineno}: handle_request no longer dispatches through _methods.get(method)")
    write = fns.get("write_json")
    if write is None:
        failures.append(f"{path}: missing write_json")
    elif not has_call(write, lambda n: isinstance(n.func, ast.Attribute) and n.func.attr == "get" and isinstance(n.func.value, ast.Name) and n.func.value.id == "obj" and n.args and lit(n.args[0]) == "method"):
        failures.append(f"{path}:{write.lineno}: write_json no longer inspects obj.get('method') for event routing")
    emit = fns.get("_emit")
    frame = fns.get("_event_frame")
    if emit is None:
        failures.append(f"{path}: missing _emit")
    elif not (emit_direct(emit) or (frame is not None and emit_uses_frame(emit) and frame_sets_type(frame))):
        failures.append(f"{path}:{emit.lineno}: _emit no longer builds a JSON-RPC event frame with params.type")

def emit_direct(fn):
    return any(isinstance(n, ast.Dict) and dict_get(n, "method") == "event" for n in ast.walk(fn)) and any(dict_sets_type(n) for n in ast.walk(fn))

def emit_uses_frame(fn):
    return has_call(fn, lambda n: name(n.func) == "_event_frame")

def frame_sets_type(fn):
    return any(isinstance(n, ast.Assign) and any(isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) and t.value.id == "params" and sub_name(t.slice) == "type" for t in n.targets) for n in ast.walk(fn)) or any(dict_sets_type(n) for n in ast.walk(fn))

def dict_get(node, key):
    for k, v in zip(node.keys, node.values):
        if lit(k) == key:
            return lit(v)
    return None

def dict_sets_type(node):
    if not isinstance(node, ast.Dict):
        return False
    return any(lit(k) == "type" and isinstance(v, ast.Name) and v.id == "event" for k, v in zip(node.keys, node.values))

def direct_event(node):
    if dict_get(node, "method") != "event":
        return None
    params = None
    for k, v in zip(node.keys, node.values):
        if lit(k) == "params" and isinstance(v, ast.Dict):
            params = v
    return dict_get(params, "type") if params is not None else None

def derives_expire(tree):
    return any(isinstance(n, ast.JoinedStr) and any(isinstance(v, ast.Constant) and ".expire" in str(v.value) for v in n.values) for n in ast.walk(tree))

def covered_dynamic(nm, node, path, stack):
    if nm == "_emit":
        first = node.args[0] if node.args else None
        if isinstance(first, ast.Name) and first.id == "event_type":
            return True
        if isinstance(first, ast.Name) and first.id == "event" and "_wire_desktop_ui" in stack:
            return True
    return False

for item in want:
    path = root / item
    if not path.exists():
        if item == "tui_gateway/server.py":
            failures.append(f"{item}: missing")
        continue
    try:
        src = path.read_text(encoding="utf-8")
        tree = ast.parse(src, filename=item)
    except SyntaxError as e:
        failures.append(f"{item}:{e.lineno}: cannot parse Python: {e.msg}")
        continue
    files.append(item)
    if item == "tui_gateway/server.py":
        validate_server(tree, item)
    Visitor(item, tree).visit(tree)

if not methods:
    failures.append("tui_gateway/server.py: no @method literal decorators found")
if not any(e["name"] == "gateway.ready" and e["path"] == "tui_gateway/ws.py" for e in events):
    failures.append("tui_gateway/ws.py: gateway.ready event frame not found")
if not any(e["name"] == "gateway.ready" and e["path"] == "tui_gateway/entry.py" for e in events):
    failures.append("tui_gateway/entry.py: gateway.ready event frame not found")

payload = {
    "failures": failures,
    "files": files,
    "methods": sorted(methods, key=lambda x: (x["name"], x["path"], x["line"])),
    "events": sorted(events, key=lambda x: (x["name"], x["path"], x["line"], x["kind"])),
    "dynamic": sorted(dynamic, key=lambda x: (x["path"], x["line"], x["call"])),
}
json.dump(payload, sys.stdout, sort_keys=True)
`

const proc = Bun.spawnSync(["python3", "-c", py])
if (proc.exitCode !== 0) {
  console.error("gen-gateway-inventory: python extraction crashed")
  console.error(new TextDecoder().decode(proc.stderr))
  process.exit(1)
}

const data = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
  failures: string[]
  files: string[]
  methods: Array<{ name: string; path: string; line: number; kind: string }>
  events: Array<{ name: string; path: string; line: number; kind: string }>
  dynamic: Array<{ path: string; line: number; call: string; rule: string }>
}

if (data.failures.length) {
  console.error("gen-gateway-inventory: extraction failed")
  for (const msg of data.failures) console.error(`- ${msg}`)
  process.exit(1)
}

const uniq = <T>(xs: T[]) => [...new Set(xs)].sort()
const methods = uniq(data.methods.map(x => x.name))
const events = uniq(data.events.map(x => x.name))
const diff = (up: string[], cur: string[]) => {
  const u = new Set(up)
  const c = new Set(cur)
  const additions = up.filter(x => !c.has(x))
  const removals = cur.filter(x => !u.has(x))
  return { additions, removals, likelyRenames: renames(additions, removals) }
}
const score = (a: string, b: string) => {
  const aa = a.split(/[._-]/)
  const bb = b.split(/[._-]/)
  const shared = aa.filter(x => bb.includes(x)).length
  return shared / Math.max(aa.length, bb.length)
}
const renames = (additions: string[], removals: string[]) => additions.flatMap(a => {
  const rows = removals.map(r => ({ from: r, to: a, score: score(a, r) })).filter(r => r.score >= 0.5)
  return rows.sort((a, b) => b.score - a.score).slice(0, 3)
})

const inventory = {
  provenance: {
    sourceRevision: sha,
    sourceLabel: `hermes-agent@${sha}`,
    extractor: "scripts/gen-gateway-inventory.ts",
    boundary: "static Python AST over explicit HERMES_AGENT_ROOT; no imports, gateway startup, HERMES_HOME reads, or producer execution",
    inputs: data.files,
  },
  rpc: {
    methods,
    sources: data.methods,
    diff: diff(methods, local.methods),
  },
  events: {
    names: events,
    sources: data.events,
    coveredDynamicSources: data.dynamic,
    diff: diff(events, local.events),
  },
} as const

const body = [
  `// Generated by scripts/gen-gateway-inventory.ts — do not edit by hand.`,
  `// Source: hermes-agent@${sha} tui_gateway/server.py`,
  `// RPC methods: ${methods.length}; events: ${events.length}`,
  ``,
  `export const GATEWAY_INVENTORY = ${JSON.stringify(inventory, null, 2)} as const`,
  ``,
  `export const GATEWAY_RPC_METHODS = GATEWAY_INVENTORY.rpc.methods`,
  `export const GATEWAY_EVENT_NAMES = GATEWAY_INVENTORY.events.names`,
  `export const GATEWAY_INVENTORY_DIFF = { rpc: GATEWAY_INVENTORY.rpc.diff, events: GATEWAY_INVENTORY.events.diff }`,
  ``,
].join("\n")

mkdirSync(dirname(target), { recursive: true })
if (Bun.argv.includes("--check")) {
  if (existsSync(target) && readFileSync(target, "utf8") === body) {
    console.error(`gen-gateway-inventory: ${target} is current (${methods.length} RPC methods, ${events.length} events)`)
    process.exit(0)
  }
  console.error(`gen-gateway-inventory: ${target} is stale`)
  if (existsSync(target)) {
    const old = readFileSync(target, "utf8")
    const before = [...old.matchAll(/"([a-zA-Z0-9_.-]+)"/g)].map(m => m[1])
    const now = [...body.matchAll(/"([a-zA-Z0-9_.-]+)"/g)].map(m => m[1])
    const report = diff(uniq(now), uniq(before))
    console.error(`additions: ${report.additions.join(", ") || "none"}`)
    console.error(`removals: ${report.removals.join(", ") || "none"}`)
    console.error(`likely renames: ${report.likelyRenames.map(r => `${r.from}->${r.to}`).join(", ") || "none"}`)
  }
  process.exit(1)
}

writeFileSync(target, body)
console.error(`gen-gateway-inventory: wrote ${relative(process.cwd(), target)} (${methods.length} RPC methods, ${events.length} events) from ${root}`)
