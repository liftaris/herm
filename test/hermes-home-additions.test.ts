import { describe, test, expect, beforeAll } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { count as tokenCount } from "../src/utils/tokens"
import { readCronOutput } from "../src/service/hermes-home"

const HH = process.env.HERMES_HOME!

beforeAll(() => {
  // Seed the sandboxed hermes home with the fixtures we need.
  mkdirSync(HH, { recursive: true })
  mkdirSync(join(HH, "hermes-agent", "plugins", "memory", "mem0"), { recursive: true })

  // SOUL.md
  writeFileSync(join(HH, "SOUL.md"), "# Identity\n\nYou are a test agent.")

  // config.yaml with a memory provider set
  writeFileSync(
    join(HH, "config.yaml"),
    "memory:\n  provider: mem0\n  memory_char_limit: 2200\n  user_char_limit: 1375\n",
  )

  // mem0.json with a realistic-length api key so redaction produces
  // a distinguishable value and the not-contains assertion below is
  // meaningful (a 3-char seed would slice to itself and hide bugs).
  writeFileSync(
    join(HH, "mem0.json"),
    JSON.stringify({ api_key: "«redacted:sk-…»", user_id: "test", foo: 42 }),
  )
})

describe("hermes-home readers", () => {
  test("SoulInfo.content exposes raw SOUL.md body", async () => {
    const { readSoul } = await import("../src/service/hermes-home")
    const s = await readSoul()
    expect(s).not.toBeNull()
    expect(s!.content).toContain("You are a test agent")
    expect(s!.charCount).toBe(s!.content.length)
    expect(s!.tokenEstimate).toBe(tokenCount(s!.content))
  })

  test("memoryProviders slice redacts secrets", async () => {
    const { home } = await import("../src/home/store")
    const mp = await home.ensure("memoryProviders")
    expect(Array.isArray(mp)).toBe(true)
    // builtin is always pushed
    expect(mp.find(p => p.name === "builtin")).toBeDefined()
    // mem0.json exists → mem0 entry present and marked active (config sets provider: mem0)
    const mem0 = mp.find(p => p.name === "mem0")
    expect(mem0).toBeDefined()
    expect(mem0!.active).toBe(true)
    // api_key redacted — full secret must be gone
    const redactedKey = mem0!.config.api_key as string
    expect(typeof redactedKey).toBe("string")
    expect(redactedKey).not.toContain("abcdef1234567890")
    expect(redactedKey.endsWith("...")).toBe(true)
  })

  test("readCronOutput: null when no dir; tail-truncates newest file", async () => {
    expect(await readCronOutput("nope")).toBeNull()

    const dir = join(HH, "cron", "output", "jx")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "20260101_000000.md"), "old")
    const body = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
    writeFileSync(join(dir, "20260102_000000.md"), body)

    const out = await readCronOutput("jx", 10)
    expect(out).not.toBeNull()
    expect(out!.text).toContain("…(40 earlier lines)")
    expect(out!.text).toContain("line 49")
    expect(out!.text).not.toContain("line 39")
    expect(out!.text).not.toContain("old")
    expect(out!.path).toContain("20260102")
  })

  test("readChangelog: first bullet → headline; null when missing", async () => {
    const { readChangelog } = await import("../src/service/hermes-home")
    expect(readChangelog()).toBeNull()
    mkdirSync(join(HH, "herm"), { recursive: true })
    writeFileSync(
      join(HH, "herm", "changelog.md"),
      "# hermes-agent — 12 new commits\n_generated 2026-05-02_\n\n- skills: curator pins important skills\n- fix: config YAML merge\n",
    )
    const c = readChangelog()
    expect(c).not.toBeNull()
    expect(c!.headline).toBe("skills: curator pins important skills")
    expect(c!.body).toContain("config YAML merge")
    expect(c!.source.relative).toBe("herm/changelog.md")
  })

  test("env helpers normalize export-prefixed keys", async () => {
    const { readEnvFile, writeEnvVar, removeEnvVar } = await import("../src/service/hermes-home")
    writeFileSync(join(HH, ".env"), "export CAMOFOX_API_KEY=one\nSLACK_BOT_TOKEN=two\n")

    expect(await readEnvFile()).toMatchObject({
      CAMOFOX_API_KEY: "one",
      SLACK_BOT_TOKEN: "two",
    })

    await writeEnvVar("CAMOFOX_API_KEY", "three")
    expect(readFileSync(join(HH, ".env"), "utf8")).toContain("CAMOFOX_API_KEY=three")

    await removeEnvVar("CAMOFOX_API_KEY")
    expect(await readEnvFile()).not.toHaveProperty("CAMOFOX_API_KEY")
  })

  test("env catalog tracks upstream browser and messaging keys", async () => {
    const { ENV_CATALOG } = await import("../src/service/hermes-home")
    const keys = ENV_CATALOG.flatMap(g => g.keys)

    for (const key of [
      "BRV_API_KEY", "CAMOFOX_API_KEY", "HINDSIGHT_API_KEY",
      "HINDSIGHT_API_URL", "RETAINDB_API_KEY", "RETAINDB_BASE_URL",
      "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "SUPERMEMORY_API_KEY",
    ]) expect(keys).toContain(key)
  })
})
