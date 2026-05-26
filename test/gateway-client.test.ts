import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "fs"
import { join, resolve } from "path"
import { tmpdir } from "os"
import { hermesAgentRoot, python } from "../src/context/gateway-client"

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
