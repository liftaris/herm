import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { gitSha } from "./schema-source"

type Declared = { name: string; path: string; line: number }
type ProducerKind = "rpc" | "slash" | "slash-extra" | "slash-dynamic"
export type Producer = {
  id: string
  kind: ProducerKind
  name: string
  source: string
  description?: string
  category?: string
  aliases?: string[]
  argsHint?: string
  subcommands?: string[]
  cliOnly?: boolean
  gatewayOnly?: boolean
  gatewayConfigGate?: string | null
  tuiExtra?: boolean
}
type Surface = {
  root: string
  sha: string
  files: string[]
  methods: Declared[]
  events: Declared[]
  producers: Producer[]
  sessionKeys: string[]
  desktopContract: number
}

export const find = (input: string) => {
  const root = resolve(input)
  if (existsSync(join(root, "tui_gateway", "server.py")) && existsSync(join(root, "hermes_cli", "commands.py")))
    return root
  throw new Error(`could not locate Hermes producer source under ${root}`)
}

export const extract = (input: string): Surface => {
  const root = find(input)
  const py = String.raw`
import ast, json, sys
from pathlib import Path

root = Path(${JSON.stringify(root)})
failures = []
files = []
methods = []
events = []
commands = []
consts = {}
seen = {}
seen_ids = set()


def fail(msg):
    failures.append(msg)


def parse(rel):
    path = root / rel
    if not path.exists():
        fail(f"{rel}: missing")
        return None
    files.append(rel)
    try:
        return ast.parse(path.read_text(encoding="utf-8"), filename=rel)
    except SyntaxError as exc:
        fail(f"{rel}:{exc.lineno}: cannot parse Python: {exc.msg}")
        return None


def name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Call):
        return name(node.func)
    return ""


def text(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def literals(tree):
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            target = node.target
        else:
            continue
        if isinstance(target, ast.Name):
            try:
                consts[target.id] = ast.literal_eval(node.value)
            except ValueError:
                pass


def value(node, where):
    try:
        return eval(compile(ast.Expression(node), where, "eval"), {"__builtins__": {}}, consts)
    except Exception as exc:
        raise RuntimeError(f"non-literal {where}: {exc}")


def sub_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Constant):
        return node.value
    return None


def dict_value(node, key):
    if not isinstance(node, ast.Dict):
        return None
    for k, val in zip(node.keys, node.values):
        if text(k) == key:
            return val
    return None


def dict_get(node, key):
    return text(dict_value(node, key))


def direct_event(node):
    if dict_get(node, "method") != "event":
        return None
    params = next((val for key, val in zip(node.keys, node.values) if text(key) == "params" and isinstance(val, ast.Dict)), None)
    return dict_get(params, "type") if params is not None else None


def ready_has_skin(tree):
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict) or direct_event(node) != "gateway.ready":
            continue
        payload = dict_value(dict_value(node, "params"), "payload")
        if isinstance(payload, ast.Dict) and dict_value(payload, "skin") is not None:
            return True
    return False


def declared(call, loop):
    first = call.args[0] if call.args else None
    if text(first) is not None:
        return [text(first)]
    if loop is not None and isinstance(first, ast.Name):
        keys = [target.id for target in loop.target.elts]
        if first.id in keys:
            return [row[keys.index(first.id)] for row in ast.literal_eval(loop.iter)]
    return None


def contracts(tree, rel):
    for stmt in tree.body:
        loop = stmt if isinstance(stmt, ast.For) and isinstance(stmt.target, ast.Tuple) else None
        for call in ast.walk(stmt):
            if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id in ("method", "event")):
                continue
            names = declared(call, loop)
            if names is None:
                fail(f"{rel}:{call.lineno}: {call.func.id}() contract name must be a literal")
                continue
            for val in names:
                label = "RPC method" if call.func.id == "method" else "event"
                if (label, val) in seen:
                    fail(f"{rel}:{call.lineno}: duplicate {label} {val!r}; first seen at {seen[(label, val)]}")
                    continue
                seen[(label, val)] = f"{rel}:{call.lineno}"
                (methods if label == "RPC method" else events).append({"name": val, "path": rel, "line": call.lineno})


registry = parse("tui_gateway/contracts/registry.py")
if registry is not None:
    defs = {node.name for node in registry.body if isinstance(node, ast.FunctionDef)}
    for item in ("method", "event"):
        if item not in defs:
            fail(f"tui_gateway/contracts/registry.py: missing def {item}")
for path in sorted((root / "tui_gateway" / "contracts").glob("*.py")):
    rel = str(path.relative_to(root))
    tree = parse(rel)
    if tree is not None:
        contracts(tree, rel)

if not methods:
    fail("tui_gateway/contracts: no method contracts found")
if not any(event["name"] == "gateway.ready" for event in events):
    fail("tui_gateway/contracts: gateway.ready event contract not found")
for item in ("tui_gateway/entry.py", "tui_gateway/ws.py"):
    tree = parse(item)
    if tree is not None and not ready_has_skin(tree):
        fail(f"{item}: gateway.ready frame with payload.skin not found")

ktree = parse("hermes_constants.py")
if ktree is not None:
    literals(ktree)
ctree = parse("hermes_cli/commands.py")
if ctree is not None:
    literals(ctree)
    table = None
    for node in ast.walk(ctree):
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "COMMAND_REGISTRY" for target in node.targets):
            table = node.value
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "COMMAND_REGISTRY":
            table = node.value
    if not isinstance(table, ast.List):
        fail("hermes_cli/commands.py: COMMAND_REGISTRY is not a literal list")
    else:
        for item in table.elts:
            if not isinstance(item, ast.Call) or name(item.func) != "CommandDef":
                fail(f"hermes_cli/commands.py:{item.lineno}: non-literal command registry entry")
                continue
            try:
                args = [value(arg, f"CommandDef arg at line {item.lineno}") for arg in item.args]
                kws = {kw.arg: value(kw.value, f"CommandDef kw at line {item.lineno}") for kw in item.keywords}
                commands.append({
                    "id": f"slash:{args[0]}",
                    "kind": "slash",
                    "name": args[0],
                    "description": args[1],
                    "category": args[2],
                    "aliases": list(kws.get("aliases", ())),
                    "argsHint": kws.get("args_hint", ""),
                    "subcommands": list(kws.get("subcommands", ())),
                    "cliOnly": bool(kws.get("cli_only", False)),
                    "gatewayOnly": bool(kws.get("gateway_only", False)),
                    "gatewayConfigGate": kws.get("gateway_config_gate"),
                    "source": f"hermes_cli/commands.py:{item.lineno}",
                })
            except RuntimeError as exc:
                fail(str(exc))

dtree = parse("tui_gateway/command_discovery.py")
if dtree is not None:
    extra = None
    for node in ast.walk(dtree):
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "_TUI_EXTRA" for target in node.targets):
            extra = node.value
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "_TUI_EXTRA":
            extra = node.value
    if not isinstance(extra, ast.List):
        fail("tui_gateway/command_discovery.py: _TUI_EXTRA is not a literal list")
    else:
        for item in extra.elts:
            try:
                vals = value(item, f"_TUI_EXTRA at line {item.lineno}")
                name_ = vals[0].lstrip("/")
                commands.append({
                    "id": f"slash-extra:{name_}",
                    "kind": "slash-extra",
                    "name": name_,
                    "description": vals[1],
                    "category": vals[2],
                    "aliases": [],
                    "argsHint": "",
                    "subcommands": [],
                    "cliOnly": False,
                    "gatewayOnly": False,
                    "gatewayConfigGate": None,
                    "tuiExtra": True,
                    "source": f"tui_gateway/command_discovery.py:{item.lineno}",
                })
            except RuntimeError as exc:
                fail(str(exc))

session_keys = []
contract = None
stree = parse("tui_gateway/server.py")
if stree is not None:
    fns = {node.name: node for node in ast.walk(stree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    info = fns.get("_session_info")
    if info is None:
        fail("tui_gateway/server.py: missing _session_info")
    else:
        class InfoVisitor(ast.NodeVisitor):
            def add(self, key):
                if isinstance(key, str) and key not in session_keys:
                    session_keys.append(key)
            def visit_Assign(self, node):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id == "info" and isinstance(node.value, ast.Dict):
                        for key in node.value.keys:
                            self.add(text(key))
                    if isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name) and target.value.id == "info":
                        self.add(sub_name(target.slice))
                self.generic_visit(node)
            def visit_AnnAssign(self, node):
                if isinstance(node.target, ast.Name) and node.target.id == "info" and isinstance(node.value, ast.Dict):
                    for key in node.value.keys:
                        self.add(text(key))
                self.generic_visit(node)
        InfoVisitor().visit(info)

    for node in stree.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "DESKTOP_BACKEND_CONTRACT" for target in node.targets):
            contract = value(node.value, "DESKTOP_BACKEND_CONTRACT")
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "DESKTOP_BACKEND_CONTRACT":
            contract = value(node.value, "DESKTOP_BACKEND_CONTRACT")
    if not isinstance(contract, int):
        fail("tui_gateway/server.py: missing integer DESKTOP_BACKEND_CONTRACT")

producers = [
    {"id": f"rpc:{item['name']}", "kind": "rpc", "name": item["name"], "source": f"{item['path']}:{item['line']}"}
    for item in methods
]
producers += commands
producers += [
    {"id": "slash-dynamic:quick_commands", "kind": "slash-dynamic", "name": "quick_commands", "source": "tui_gateway/command_discovery.py:dynamic", "description": "Profile quick commands discovered at runtime by commands.catalog."},
    {"id": "slash-dynamic:skills", "kind": "slash-dynamic", "name": "skills", "source": "tui_gateway/command_discovery.py:dynamic", "description": "Skill commands discovered at runtime by commands.catalog."},
]
for item in producers:
    if item["id"] in seen_ids:
        fail(f"duplicate producer id: {item['id']}")
    seen_ids.add(item["id"])

json.dump({
    "failures": failures,
    "files": sorted(set(files)),
    "methods": sorted(methods, key=lambda item: (item["name"], item["path"], item["line"])),
    "events": sorted(events, key=lambda item: (item["name"], item["path"], item["line"])),
    "producers": sorted(producers, key=lambda item: item["id"]),
    "session_keys": session_keys,
    "desktop_contract": contract,
}, sys.stdout, sort_keys=True)
`
  const proc = Bun.spawnSync(["python3", "-c", py])
  if (proc.exitCode !== 0)
    throw new Error(`Hermes producer extraction crashed\n${new TextDecoder().decode(proc.stderr)}`)
  const data = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
    failures: string[]
    files: string[]
    methods: Declared[]
    events: Declared[]
    producers: Producer[]
    session_keys: string[]
    desktop_contract: number
  }
  if (data.failures.length) throw new Error(`Hermes producer extraction failed\n${data.failures.map(msg => `- ${msg}`).join("\n")}`)
  return {
    root,
    sha: gitSha(root),
    files: data.files,
    methods: data.methods,
    events: data.events,
    producers: data.producers,
    sessionKeys: data.session_keys,
    desktopContract: data.desktop_contract,
  }
}

export * as hermesSource from "./hermes-source"
