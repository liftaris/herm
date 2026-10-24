import { describe, expect, test } from "bun:test"
import { tmpHome } from "./fixture/home"
import { prefs } from "../src/context/preferences"
import { hermesPath } from "../src/service/hermes-home"

describe("tmpHome fixture", () => {
  test("rebinds hermes home and config dirs, then restores them", async () => {
    const prev = {
      home: process.env.HERMES_HOME,
      cfg: process.env.HERM_CONFIG_DIR,
    }
    let dir = ""

    {
      await using h = await tmpHome({
        config: { memory: { provider: "mem0" } },
        files: { "memories/MEMORY.md": "one" },
        prefs: { theme: "tokyonight", lastSessionId: "sid-a" },
      })
      dir = h.path

      expect(process.env.HERMES_HOME).toBe(h.path)
      expect(process.env.HERM_CONFIG_DIR).toBe(h.cfg)
      expect(hermesPath("memories/MEMORY.md")).toBe(`${h.path}/memories/MEMORY.md`)
      expect(await Bun.file(hermesPath("memories/MEMORY.md")).text()).toBe("one")
      expect(prefs.get("theme")).toBe("tokyonight")
      expect(prefs.get("lastSessionId")).toBe("sid-a")

      h.write("sessions/sessions.json", JSON.stringify({ a: { session_id: "sid-a" } }))
      expect(await Bun.file(hermesPath("sessions/sessions.json")).exists()).toBe(true)
    }

    expect(process.env.HERMES_HOME).toBe(prev.home)
    expect(process.env.HERM_CONFIG_DIR).toBe(prev.cfg)
    expect(await Bun.file(`${dir}/memories/MEMORY.md`).exists()).toBe(false)
  })
})
