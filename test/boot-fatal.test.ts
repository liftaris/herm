import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { TERMINAL_MODE_RESET } from "../src/utils/terminal-reset"

describe("boot fatal handling", () => {
  test("exits nonzero after terminal cleanup on early startup failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "herm-boot-fatal-"))
    try {
      const child = Bun.spawn([process.execPath, "-e", `
        const { fatal } = await import("./src/app/fatal")
        Object.defineProperty(process.stdout, "isTTY", { value: true })
        process.stdin.resume()
        fatal(new Error("boot exploded"))
      `], {
        cwd: resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HERMES_HOME: join(root, "home"),
          HERM_CONFIG_DIR: join(root, "cfg"),
          HERMES_AGENT_ROOT: join(root, "agent"),
          CONTROL: "",
          PERF: "",
        },
      })
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])

      expect(code).toBe(1)
      expect(out).toContain(TERMINAL_MODE_RESET)
      expect(err).toContain("boot exploded")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
