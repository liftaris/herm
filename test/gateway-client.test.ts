import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
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
    withEnv("HERMES_AGENT_ROOT", resolve("custom", "agent"), () => {
      withEnv("HERMES_HOME", resolve("custom", "home"), () => {
        expect(hermesAgentRoot()).toBe(resolve("custom", "agent"))
      })
    })
  })

  test("falls back to HERMES_HOME/hermes-agent", () => {
    withEnv("HERMES_AGENT_ROOT", undefined, () => {
      withEnv("HERMES_HOME", resolve("custom", "home"), () => {
        expect(hermesAgentRoot()).toBe(resolve("custom", "home", "hermes-agent"))
      })
    })
  })

  test("falls back to HOME/.hermes/hermes-agent", () => {
    withEnv("HERMES_AGENT_ROOT", undefined, () => {
      withEnv("HERMES_HOME", undefined, () => {
        withEnv("HOME", resolve("custom", "user"), () => {
          expect(hermesAgentRoot()).toBe(resolve("custom", "user", ".hermes", "hermes-agent"))
        })
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
