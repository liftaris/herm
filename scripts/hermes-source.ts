import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { gitSha } from "./schema-source"

type Method = { name: string; path: string; line: number; kind: string }
type Event = { name: string; path: string; line: number; kind: string }
type Dynamic = { path: string; line: number; call: string; rule: string }
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
  methods: Method[]
  events: Event[]
  dynamic: Dynamic[]
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
dynamic = []
commands = []
seen_methods = {}
seen_events = set()
seen_ids = set()

want = [
    "tui_gateway/server.py",
    "tui_gateway/ws.py",
    "tui_gateway/entry.py",
    "tools/delegate_tool.py",
]
want += [str(p.relative_to(root)) for p in sorted((root / "tools").glob("*.py")) if p.exists()]
want = sorted(set(want))
server_path = root / "tui_gateway" / "server.py"
commands_path = root / "hermes_cli" / "commands.py"


def fail(msg):
    failures.append(msg)


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


def text(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def value(node, where):
    try:
        return ast.literal_eval(node)
    except Exception as exc:
        raise RuntimeError(f"non-literal {where}: {exc}")


def sub_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Constant):
        return node.value
    return None


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


def dict_value(node, key):
    if not isinstance(node, ast.Dict):
        return None
    for k, val in zip(node.keys, node.values):
        if text(k) == key:
            return val
    return None


def dict_get(node, key):
    return text(dict_value(node, key))


def dict_sets_type(node):
    return isinstance(node, ast.Dict) and any(
        text(k) == "type" and isinstance(val, ast.Name) and val.id == "event"
        for k, val in zip(node.keys, node.values)
    )


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


def derives_expire(tree):
    return any(
        isinstance(n, ast.JoinedStr)
        and any(isinstance(val, ast.Constant) and ".expire" in str(val.value) for val in n.values)
        for n in ast.walk(tree)
    )


def covered_dynamic(call, node, stack):
    if call != "_emit":
        return False
    first = node.args[0] if node.args else None
    if isinstance(first, ast.Name) and first.id == "event_type":
        return True
    return isinstance(first, ast.Name) and first.id == "event" and "_wire_desktop_ui" in stack


def emit_direct(fn):
    return any(isinstance(n, ast.Dict) and dict_get(n, "method") == "event" for n in ast.walk(fn)) \
        and any(dict_sets_type(n) for n in ast.walk(fn))


def emit_uses_frame(fn):
    return has_call(fn, lambda n: name(n.func) == "_event_frame")


def frame_sets_type(fn):
    return any(
        isinstance(n, ast.Assign)
        and any(
            isinstance(target, ast.Subscript)
            and isinstance(target.value, ast.Name)
            and target.value.id == "params"
            and sub_name(target.slice) == "type"
            for target in n.targets
        )
        for n in ast.walk(fn)
    ) or any(dict_sets_type(n) for n in ast.walk(fn))


def validate_server(tree, path):
    fns = {n.name: n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    method = fns.get("method")
    if method is None:
        fail(f"{path}: missing def method(name)")
    elif not has_assign(method, lambda n: any(
        isinstance(target, ast.Subscript)
        and isinstance(target.value, ast.Name)
        and target.value.id == "_methods"
        and sub_name(target.slice) == "name"
        for target in getattr(n, "targets", [getattr(n, "target", None)])
    )):
        fail(f"{path}:{method.lineno}: method() no longer registers _methods[name]")
    handle = fns.get("handle_request")
    if handle is None:
        fail(f"{path}: missing handle_request")
    elif not has_call(handle, lambda n:
        isinstance(n.func, ast.Attribute)
        and n.func.attr == "get"
        and isinstance(n.func.value, ast.Name)
        and n.func.value.id == "_methods"
        and n.args
        and isinstance(n.args[0], ast.Name)
        and n.args[0].id == "method"
    ):
        fail(f"{path}:{handle.lineno}: handle_request no longer dispatches through _methods.get(method)")
    write = fns.get("write_json")
    if write is None:
        fail(f"{path}: missing write_json")
    elif not has_call(write, lambda n:
        isinstance(n.func, ast.Attribute)
        and n.func.attr == "get"
        and isinstance(n.func.value, ast.Name)
        and n.func.value.id == "obj"
        and n.args
        and text(n.args[0]) == "method"
    ):
        fail(f"{path}:{write.lineno}: write_json no longer inspects obj.get('method') for event routing")
    emit = fns.get("_emit")
    frame = fns.get("_event_frame")
    if emit is None:
        fail(f"{path}: missing _emit")
    elif not (emit_direct(emit) or (frame is not None and emit_uses_frame(emit) and frame_sets_type(frame))):
        fail(f"{path}:{emit.lineno}: _emit no longer builds a JSON-RPC event frame with params.type")


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
                call = name(dec)
                if call == "method" and "_projects_method" not in self.stack:
                    val = text(dec.args[0]) if dec.args else None
                    if val is None:
                        fail(f"{self.path}:{node.lineno}: @method decorator must use a literal string")
                    elif val in seen_methods:
                        fail(f"{self.path}:{node.lineno}: duplicate RPC method {val!r}; first seen at {seen_methods[val]}")
                    else:
                        seen_methods[val] = f"{self.path}:{node.lineno}"
                        methods.append({"name": val, "path": self.path, "line": node.lineno, "kind": "decorator"})
                if call == "_projects_method":
                    val = text(dec.args[0]) if dec.args else None
                    if val is None:
                        fail(f"{self.path}:{node.lineno}: @_projects_method decorator must use a literal string")
                    elif val in seen_methods:
                        fail(f"{self.path}:{node.lineno}: duplicate RPC method {val!r}; first seen at {seen_methods[val]}")
                    else:
                        seen_methods[val] = f"{self.path}:{node.lineno}"
                        methods.append({"name": val, "path": self.path, "line": node.lineno, "kind": "projects-wrapper"})
        self.stack.append(node.name)
        for child in node.body:
            self.visit(child)
        self.stack.pop()

    def visit_Call(self, node):
        call = name(node.func)
        val = text(node.args[0]) if node.args else None
        if self.path == "tui_gateway/server.py" and call in {"_emit", "_block", "_broadcast_global_event", "_voice_emit"}:
            if self.stack and self.stack[-1] in {"_emit", "_block", "_broadcast_global_event", "_voice_emit", "_event_frame"}:
                pass
            elif val is not None:
                add_event(val, self.path, node.lineno, call)
                if call == "_block" and derives_expire(self.tree):
                    add_event(val.removesuffix(".request") + ".expire", self.path, node.lineno, "derived-expire")
            elif covered_dynamic(call, node, self.stack):
                dynamic.append({"path": self.path, "line": node.lineno, "call": call, "rule": "delegate-subagent-relay"})
            else:
                fail(f"{self.path}:{node.lineno}: {call} event argument must be a literal or covered rule")
        if call == "emit" and attr_base(node.func) == "desktop_ui":
            if val is not None:
                add_event(val, self.path, node.lineno, "desktop_ui.emit")
            else:
                fail(f"{self.path}:{node.lineno}: desktop_ui.emit event argument must be literal")
        if val and val.startswith("subagent.") and self.path == "tools/delegate_tool.py" and val != "subagent.text":
            add_event(val, self.path, node.lineno, "delegate-tool")
        self.generic_visit(node)

    def visit_Dict(self, node):
        event = direct_event(node)
        if event is not None:
            add_event(event, self.path, node.lineno, "jsonrpc-event-frame")
        self.generic_visit(node)


trees = {}
for item in want:
    path = root / item
    if not path.exists():
        if item == "tui_gateway/server.py":
            fail(f"{item}: missing")
        continue
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=item)
    except SyntaxError as exc:
        fail(f"{item}:{exc.lineno}: cannot parse Python: {exc.msg}")
        continue
    files.append(item)
    trees[item] = tree
    if item == "tui_gateway/server.py":
        validate_server(tree, item)
    Visitor(item, tree).visit(tree)

if not commands_path.exists():
    fail("hermes_cli/commands.py: missing")
else:
    files.append("hermes_cli/commands.py")
    ctree = ast.parse(commands_path.read_text(encoding="utf-8"), filename="hermes_cli/commands.py")
    registry = None
    for node in ast.walk(ctree):
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "COMMAND_REGISTRY" for target in node.targets):
            registry = node.value
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "COMMAND_REGISTRY":
            registry = node.value
    if not isinstance(registry, ast.List):
        fail("hermes_cli/commands.py: COMMAND_REGISTRY is not a literal list")
    else:
        for item in registry.elts:
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

stree = trees.get("tui_gateway/server.py")
if stree is not None:
    extra = None
    for node in ast.walk(stree):
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "_TUI_EXTRA" for target in node.targets):
            extra = node.value
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "_TUI_EXTRA":
            extra = node.value
    if not isinstance(extra, ast.List):
        fail("tui_gateway/server.py: _TUI_EXTRA is not a literal list")
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
                    "source": f"tui_gateway/server.py:{item.lineno}",
                })
            except RuntimeError as exc:
                fail(str(exc))

    fns = {node.name: node for node in ast.walk(stree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    info = fns.get("_session_info")
    session_keys = []
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

    contract = None
    for node in stree.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "DESKTOP_BACKEND_CONTRACT" for target in node.targets):
            contract = value(node.value, "DESKTOP_BACKEND_CONTRACT")
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "DESKTOP_BACKEND_CONTRACT":
            contract = value(node.value, "DESKTOP_BACKEND_CONTRACT")
    if not isinstance(contract, int):
        fail("tui_gateway/server.py: missing integer DESKTOP_BACKEND_CONTRACT")
else:
    session_keys = []
    contract = None

if not methods:
    fail("tui_gateway/server.py: no literal RPC decorators found")
if not any(event["name"] == "gateway.ready" and event["path"] == "tui_gateway/ws.py" for event in events):
    fail("tui_gateway/ws.py: gateway.ready event frame not found")
if not any(event["name"] == "gateway.ready" and event["path"] == "tui_gateway/entry.py" for event in events):
    fail("tui_gateway/entry.py: gateway.ready event frame not found")
for item in ("tui_gateway/entry.py", "tui_gateway/ws.py"):
    tree = trees.get(item)
    if tree is not None and not ready_has_skin(tree):
        fail(f"{item}: gateway.ready payload.skin not found")

producers = [
    {"id": f"rpc:{item['name']}", "kind": "rpc", "name": item["name"], "source": f"{item['path']}:{item['line']}"}
    for item in methods
]
producers += commands
producers += [
    {"id": "slash-dynamic:quick_commands", "kind": "slash-dynamic", "name": "quick_commands", "source": "tui_gateway/server.py:dynamic", "description": "Profile quick commands discovered at runtime by commands.catalog."},
    {"id": "slash-dynamic:skills", "kind": "slash-dynamic", "name": "skills", "source": "tui_gateway/server.py:dynamic", "description": "Skill commands discovered at runtime by commands.catalog."},
]
for item in producers:
    if item["id"] in seen_ids:
        fail(f"duplicate producer id: {item['id']}")
    seen_ids.add(item["id"])

json.dump({
    "failures": failures,
    "files": sorted(set(files)),
    "methods": sorted(methods, key=lambda item: (item["name"], item["path"], item["line"])),
    "events": sorted(events, key=lambda item: (item["name"], item["path"], item["line"], item["kind"])),
    "dynamic": sorted(dynamic, key=lambda item: (item["path"], item["line"], item["call"])),
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
    methods: Method[]
    events: Event[]
    dynamic: Dynamic[]
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
    dynamic: data.dynamic,
    producers: data.producers,
    sessionKeys: data.session_keys,
    desktopContract: data.desktop_contract,
  }
}

export * as hermesSource from "./hermes-source"
