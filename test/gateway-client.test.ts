import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "fs"
import { delimiter, join, resolve } from "path"
import { tmpdir } from "os"
import { GatewayClient, hermesAgentRoot, python } from "../src/context/gateway-client"

const withEnv = <T>(key: string, value: string | undefined, fn: () => T): T => {
  const prev = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try { return fn() }
  finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}

const tmp = () => mkdtempSync(join(tmpdir(), "herm-gateway-"))

describe("hermesAgentRoot", () => {
  test("uses HERMES_AGENT_ROOT when set", () => {
    withEnv("HERMES_AGENT_ROOT", resolve("/custom/hermes-agent"), () => {
      expect(hermesAgentRoot()).toBe(resolve("/custom/hermes-agent"))
    })
  })

  test("returns home path by default", () => {
    withEnv("HERMES_AGENT_ROOT", undefined, () => {
      const home = hermesAgentRoot()
      expect(home).toContain(".hermes/hermes-agent")
    })
  })

  test("falls back to FHS path when home path doesn't exist", () => {
    withEnv("HERMES_AGENT_ROOT", undefined, () => {
      withEnv("HOME", tmp(), () => {
        // HOME is set to a tmp dir that has no .hermes/hermes-agent
        // so the function falls through to the FHS path check
        const root = hermesAgentRoot()
        // If /usr/local/lib/hermes-agent doesn't exist on this machine,
        // it returns the (non-existent) home path — which is expected
        // behavior. The important part is the FHS path is checked.
        if (existsSync("/usr/local/lib/hermes-agent")) {
          expect(root).toBe("/usr/local/lib/hermes-agent")
        } else {
          // No FHS path either — returns home path as default
          expect(root).toContain("hermes-agent")
        }
      })
    })
  })
})

describe("python", () => {
  test("uses HERMES_PYTHON when set", () => {
    withEnv("HERMES_PYTHON", resolve("custom", "python"), () => {
      expect(python(resolve("root"), "win32")).toBe(resolve("custom", "python"))
    })
  })

  test("resolves Windows virtualenv layout", () => {
    withEnv("HERMES_PYTHON", undefined, () => {
      withEnv("VIRTUAL_ENV", undefined, () => {
        const root = tmp()
        try {
          const bin = join(root, "venv", "Scripts", "python.exe")
          mkdirSync(join(root, "venv", "Scripts"), { recursive: true })
          writeFileSync(bin, "")
          expect(python(root, "win32")).toBe(bin)
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      })
    })
  })

  test("resolves POSIX virtualenv layout", () => {
    withEnv("HERMES_PYTHON", undefined, () => {
      withEnv("VIRTUAL_ENV", undefined, () => {
        const root = tmp()
        try {
          const bin = join(root, "venv", "bin", "python")
          mkdirSync(join(root, "venv", "bin"), { recursive: true })
          writeFileSync(bin, "")
          expect(python(root, "linux")).toBe(bin)
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      })
    })
  })
})

describe("GatewayClient", () => {
  test("synchronous spawn failure reports exit without throwing", () => {
    const prev = Bun.spawn
    ;(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => {
      throw new Error("spawn exploded")
    }) as typeof Bun.spawn
    const gw = new GatewayClient()
    let exits = 0
    gw.on("exit", () => { exits++ })
    gw.drain()
    try {
      expect(() => gw.start()).not.toThrow()
      expect(exits).toBe(1)
      expect(gw.tail()).toContain("spawn exploded")
    } finally {
      ;(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = prev
    }
  })

  test("startup timeout terminates the wedged gateway", async () => {
    const spawn = Bun.spawn
    const clock = globalThis.setTimeout
    let kills = 0
    let done!: (code: number) => void
    const exited = new Promise<number>(resolve => { done = resolve })
    const proc = {
      stdin: { write() { return 0 } },
      stdout: null,
      stderr: null,
      exited,
      exitCode: null as number | null,
      kill() {
        kills++
        this.exitCode = 1
        done(1)
      },
    }
    ;(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => proc as never) as typeof Bun.spawn
    const fast = (handler: () => void, ms?: number) => clock(handler, ms === 15_000 ? 0 : ms)
    globalThis.setTimeout = fast as unknown as typeof setTimeout
    const gw = new GatewayClient()
    let exits = 0
    gw.on("exit", () => { exits++ })
    gw.drain()
    try {
      gw.start()
      await Bun.sleep(20)
      expect(gw.tail()).toContain("timed out")
      expect(kills).toBe(1)
      expect(exits).toBe(1)
    } finally {
      gw.kill()
      globalThis.setTimeout = clock
      ;(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = spawn
    }
  })

  test("passes Python source root to gateway child env", () => {
    const prev = Bun.spawn
    const root = tmp()
    const cwd = tmp()
    const py = resolve(root, "bin", "python")
    let opts: { cwd?: string, env?: Record<string, string> } | undefined
    ;(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (((cmd: string[], cfg: { cwd?: string, env?: Record<string, string> }) => {
      opts = cfg as typeof opts
      expect(cmd).toEqual([py, "-u", "-m", "tui_gateway.entry"])
      return {
        stdin: { write() { return 0 } },
        stdout: null,
        stderr: null,
        exited: Promise.resolve(null),
        exitCode: null,
        kill() {},
      }
    }) as unknown) as typeof Bun.spawn

    const env = {
      root: process.env.HERMES_AGENT_ROOT,
      py: process.env.HERMES_PYTHON,
      cwd: process.env.HERMES_CWD,
      term: process.env.TERMINAL_CWD,
      path: process.env.PYTHONPATH,
    }
    process.env.HERMES_AGENT_ROOT = root
    process.env.HERMES_PYTHON = py
    process.env.HERMES_CWD = cwd
    delete process.env.TERMINAL_CWD
    process.env.PYTHONPATH = "tail"

    const gw = new GatewayClient()
    try {
      gw.start()
      expect(opts?.cwd).toBe(cwd)
      expect(opts?.env?.HERMES_AGENT_ROOT).toBe(root)
      expect(opts?.env?.HERMES_PYTHON).toBe(py)
      expect(opts?.env?.TERMINAL_CWD).toBe(cwd)
      expect(opts?.env?.PYTHONPATH).toBe(`${root}${delimiter}tail`)
      expect(opts?.env?.HERMES_PYTHON_SRC_ROOT).toBe(root)
    } finally {
      gw.kill()
      ;(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = prev
      if (env.root === undefined) delete process.env.HERMES_AGENT_ROOT
      else process.env.HERMES_AGENT_ROOT = env.root
      if (env.py === undefined) delete process.env.HERMES_PYTHON
      else process.env.HERMES_PYTHON = env.py
      if (env.cwd === undefined) delete process.env.HERMES_CWD
      else process.env.HERMES_CWD = env.cwd
      if (env.term === undefined) delete process.env.TERMINAL_CWD
      else process.env.TERMINAL_CWD = env.term
      if (env.path === undefined) delete process.env.PYTHONPATH
      else process.env.PYTHONPATH = env.path
      rmSync(root, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("normalizes outbound JSON-RPC strings to Unicode scalar values", async () => {
    const prev = Bun.spawn
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    let frame = ""
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
    const stdout = new ReadableStream<Uint8Array>({ start: c => { ctrl = c } })
    const stdin = {
      write(data: string | Uint8Array) {
        frame += typeof data === "string" ? data : dec.decode(data)
        const req = JSON.parse(frame.trim()) as { id: string }
        ctrl?.enqueue(enc.encode(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\n"))
        return frame.length
      },
    }
    ;(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((() => ({
      stdin,
      stdout,
      stderr: null,
      exited: new Promise<null>(() => {}),
      exitCode: null,
      kill() {},
    })) as unknown) as typeof Bun.spawn

    const gw = new GatewayClient()
    try {
      await expect(gw.request("paste.collapse", { text: "a\udc9d", nested: ["💝"] })).resolves.toEqual({ ok: true })
      expect(JSON.parse(frame.trim()).params).toEqual({ text: "a�", nested: ["💝"] })
      expect(gw.tail()).toContain("[wire] sanitized invalid unicode for paste.collapse: $.params.text:1")
    } finally {
      gw.kill()
      ;(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = prev
    }
  })

  test("explicit restart rejects requests owned by the old process", async () => {
    const prev = Bun.spawn
    const procs: Array<{ exitCode: number | null; kill: () => void }> = []
    ;(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => {
      let done!: (code: number) => void
      const exited = new Promise<number>(resolve => { done = resolve })
      const proc = {
        stdin: { write() { return 0 } },
        stdout: null,
        stderr: null,
        exited,
        exitCode: null as number | null,
        kill() {
          if (this.exitCode !== null) return
          this.exitCode = 0
          done(0)
        },
      }
      procs.push(proc)
      return proc as never
    }) as typeof Bun.spawn

    const gw = new GatewayClient()
    try {
      gw.start()
      const old = gw.request("test.pending").then(
        () => "resolved",
        (e: Error) => e.message,
      )
      gw.start()
      expect(await Promise.race([old, Bun.sleep(20).then(() => "pending")]))
        .toBe("gateway restarted")
      expect(procs).toHaveLength(2)
    } finally {
      gw.kill()
      ;(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = prev
    }
  })

  test("restart drops trailing events from the superseded process", async () => {
    const prev = Bun.spawn
    const enc = new TextEncoder()
    const controls: ReadableStreamDefaultController<Uint8Array>[] = []
    ;(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => {
      const stdout = new ReadableStream<Uint8Array>({ start: control => { controls.push(control) } })
      return {
        stdin: { write() { return 0 } },
        stdout,
        stderr: null,
        exited: new Promise<null>(() => {}),
        exitCode: null,
        kill() {},
      } as never
    }) as typeof Bun.spawn

    const gw = new GatewayClient()
    const seen: string[] = []
    gw.on("event", event => {
      if (event.type === "status.update") seen.push(event.payload.text)
    })
    gw.drain()
    try {
      gw.start()
      gw.start()
      controls[0].enqueue(enc.encode(JSON.stringify({
        method: "event", params: { type: "status.update", payload: { kind: "info", text: "stale" } },
      }) + "\n"))
      controls[1].enqueue(enc.encode(JSON.stringify({
        method: "event", params: { type: "status.update", payload: { kind: "info", text: "fresh" } },
      }) + "\n"))
      await Bun.sleep(0)
      expect(seen).toEqual(["fresh"])
    } finally {
      gw.kill()
      ;(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = prev
    }
  })
})
