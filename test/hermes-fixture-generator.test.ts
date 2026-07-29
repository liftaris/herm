import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const script = join(import.meta.dir, "../scripts/gen-hermes-fixtures.ts")
const generator = join(import.meta.dir, "../scripts/gen-hermes-manifest.ts")
const schemaGenerator = join(import.meta.dir, "../scripts/gen-schema.ts")

const run = async (root: string, args: string[] = [], agent = join(root, "agent")) => {
  const manifest = join(root, "manifest.ts")
  const schema = join(root, "schema.ts")
  const env = { ...process.env, HOME: join(root, "home"), HERMES_HOME: join(root, "hermes"), HERMES_AGENT_ROOT: agent }
  if (!existsSync(manifest)) {
    const overlay = join(root, "overlay.ts")
    writeFileSync(overlay, `export const CAPABILITY_COVERAGE = ${JSON.stringify({
      "rpc:session.create": { classification: "covered.rpc", rationale: "fixture" },
      "slash-dynamic:quick_commands": { classification: "covered.slash_gateway", rationale: "fixture" },
      "slash-dynamic:skills": { classification: "covered.slash_gateway", rationale: "fixture" },
    })}\n`)
    const prep = Bun.spawn(["bun", generator, "--agent", agent, "--out", manifest, "--overlay", overlay], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, err] = await Promise.all([prep.exited, new Response(prep.stderr).text()])
    if (code !== 0) return { code, err }
  }
  if (!existsSync(schema)) {
    const prep = Bun.spawn(["bun", schemaGenerator, "--out", schema], { env, stdout: "pipe", stderr: "pipe" })
    const [code, err] = await Promise.all([prep.exited, new Response(prep.stderr).text()])
    if (code !== 0) return { code, err }
  }
  const proc = Bun.spawn(["bun", script, "--agent-root", agent, "--manifest", manifest, "--schema", schema, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  return { code, err }
}

const write = (root: string) => {
  const dir = join(root, "agent")
  mkdirSync(join(dir, "hermes_cli"), { recursive: true })
  mkdirSync(join(dir, "tui_gateway"), { recursive: true })
  writeFileSync(join(dir, "hermes_cli", "config.py"), `DEFAULT_CONFIG = {
    "agent": {"gateway_timeout": 42},
    "approvals": {"mode": "smart"},
}
`)
  writeFileSync(join(dir, "hermes_cli", "commands.py"), `COMMAND_REGISTRY = []\n`)
  writeFileSync(join(dir, "tui_gateway", "server.py"), `_methods = {}
DESKTOP_BACKEND_CONTRACT = 7
_APPROVAL_MODES = frozenset({"manual", "smart", "off"})
_TUI_EXTRA: list[tuple[str, str, str]] = []

def write_json(obj):
    if obj.get("method") == "event":
        pass

def _event_frame(event: str, sid: str, payload: dict | None = None) -> dict:
    params: dict = {"type": event, "session_id": sid}
    if payload is not None:
        params["payload"] = payload
    return {"jsonrpc": "2.0", "method": "event", "params": params}

def _emit(event, sid, payload=None):
    write_json(_event_frame(event, sid, payload))

def method(name):
    def dec(fn):
        _methods[name] = fn
        return fn
    return dec

def handle_request(req):
    method = req.get("method")
    fn = _methods.get(method)
    return fn(None, {})

def _session_info(agent, session=None):
    info: dict = {
        "model": "",
        "tools": {},
        "skills": {},
        "desktop_contract": DESKTOP_BACKEND_CONTRACT,
    }
    info["version"] = ""
    return info

@method("session.create")
def create(rid, params):
    _emit("message.start", "fixture")
    _emit("session.info", "fixture")
    _emit("status.update", "fixture")
    _emit("tool.start", "fixture")
    _emit("tool.complete", "fixture")
    return {}
`)
  writeFileSync(join(dir, "tui_gateway", "entry.py"), `def main():
    write_json({
        "jsonrpc": "2.0",
        "method": "event",
        "params": {"type": "gateway.ready", "payload": {"skin": resolve_skin()}},
    })
`)
  writeFileSync(join(dir, "tui_gateway", "ws.py"), `async def serve(transport):
    await transport.write_async({
        "jsonrpc": "2.0",
        "method": "event",
        "params": {
            "type": "gateway.ready",
            "payload": {"skin": server.resolve_skin()},
        },
    })
`)
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir })
  expect(git("init", "-q").exitCode).toBe(0)
  expect(git("add", ".").exitCode).toBe(0)
  expect(git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture").exitCode).toBe(0)
}

describe("Hermes compatibility fixture generator", () => {
  test("static extraction is deterministic and detects stale committed fixtures", async () => {
    const root = mkdtempSync(join(tmpdir(), "herm-producer-"))
    const one = join(root, "one")
    const two = join(root, "two")
    const link = join(root, "link")
    try {
      write(root)
      symlinkSync(join(root, "agent"), link, "dir")
      expect(await run(root, ["--out", one])).toMatchObject({ code: 0 })
      expect((await run(root, ["--out", two], link)).code).toBe(0)
      for (const name of ["README.md", "config.json", "gateway-events.json", "session-info.json"])
        expect(await Bun.file(join(two, name)).text()).toBe(await Bun.file(join(one, name)).text())
      const session = await Bun.file(join(one, "session-info.json")).json()
      expect(session.metadata.source_revision).toHaveLength(40)
      expect(session.metadata.generation_command).toContain("scripts/gen-hermes-fixtures.ts")
      expect(session.metadata.generation_command).not.toContain(root)
      expect(session.frame.params.payload.desktop_contract).toBe(7)
      const config = await Bun.file(join(one, "config.json")).json()
      expect(config.canonical).toEqual({ approval_mode: "smart", approval_modes: ["manual", "smart", "off"], gateway_timeout: 42 })
      expect(config.default_config).toBeUndefined()
      expect((await run(root, ["--check", "--out", one], link)).code).toBe(0)
      writeFileSync(join(one, "session-info.json"), "{}\n")
      const stale = await run(root, ["--check", "--out", one])
      expect(stale.code).toBe(1)
      expect(stale.err).toContain("session-info.json")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
