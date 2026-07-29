import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const script = join(import.meta.dir, "../scripts/gen-hermes-fixtures.ts")

const run = async (root: string, args: string[] = [], agent = join(root, "agent")) => {
  const proc = Bun.spawn(["bun", script, "--agent-root", agent, ...args], {
    env: {
      ...process.env,
      HOME: join(root, "home"),
      HERMES_HOME: join(root, "hermes"),
      HERM_CONFIG_DIR: join(root, "config"),
      HERM_GATEWAY_URL: "ws://should-be-cleared.test",
      HERMES_TUI_GATEWAY_URL: "ws://should-be-cleared.test",
    },
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
  writeFileSync(join(dir, "tui_gateway", "server.py"), `DESKTOP_BACKEND_CONTRACT = 7
_APPROVAL_MODES = frozenset({"manual", "smart", "off"})

def _event_frame(event: str, sid: str, payload: dict | None = None) -> dict:
    params: dict = {"type": event, "session_id": sid}
    if payload is not None:
        params["payload"] = payload
    return {"jsonrpc": "2.0", "method": "event", "params": params}

def _session_info(agent, session=None):
    info: dict = {
        "model": "",
        "tools": {},
        "skills": {},
        "desktop_contract": DESKTOP_BACKEND_CONTRACT,
    }
    info["version"] = ""
    return info
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
      expect((await run(root, ["--out", one])).code).toBe(0)
      expect((await run(root, ["--out", two], link)).code).toBe(0)
      for (const name of ["README.md", "config.json", "gateway-events.json", "session-info.json"])
        expect(await Bun.file(join(two, name)).text()).toBe(await Bun.file(join(one, name)).text())
      const session = await Bun.file(join(one, "session-info.json")).json()
      expect(session.metadata.source_revision).toHaveLength(40)
      expect(session.metadata.generation_command).toContain("scripts/gen-hermes-fixtures.ts")
      expect(session.metadata.generation_command).not.toContain(root)
      expect(session.frame.params.payload.desktop_contract).toBe(7)
      expect((await run(root, ["--check", "--out", one], link)).code).toBe(0)
      writeFileSync(join(one, "session-info.json"), "{}\n")
      const stale = await run(root, ["--check", "--out", one])
      expect(stale.code).toBe(1)
      expect(stale.err).toContain("session-info.json")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("refuses implicit producer discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "herm-producer-"))
    const env: Record<string, string | undefined> = { ...process.env, HOME: join(root, "home"), HERMES_HOME: join(root, "hermes") }
    delete env.HERMES_AGENT_ROOT
    const proc = Bun.spawn(["bun", script], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    rmSync(root, { recursive: true, force: true })
    expect(code).toBe(2)
    expect(err).toContain("--agent-root")
  })
})
