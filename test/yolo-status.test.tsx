import { describe, expect, test } from "bun:test"
import { act } from "react"
import { mount as mountApp, until, MockGateway } from "./harness"
import { yoloScopeFromMouse } from "../src/components/chat/Composer"
import { check } from "../src/config/rules"
import { buildFields } from "../src/config"
import type { ConfigSetResponse, SessionInfo } from "../src/context/wire"

describe("yolo status control", () => {
  test("Composer yolo chip toggles session scope and refreshes from config.set info", async () => {
    const gw = new MockGateway({
      "config.set": p => ({
        value: "on",
        scope: "session",
        info: { model: "test-model", session_id: p.session_id, tools: {}, skills: {}, yolo: true },
      }),
    })
    const t = await mountApp({ gw })
    await until(t, () => t.frame().includes("yolo") && t.frame().includes("Ready"))

    act(() => { t.keys.pressKey("x", { ctrl: true }); t.keys.pressKey("z") })
    await until(t, () => t.gw.last("config.set")?.params.key === "yolo")

    expect(t.gw.last("config.set")?.params).toMatchObject({ key: "yolo", scope: "global", session_id: "test-sid" })
    expect(t.frame()).toContain("yolo on")

    t.destroy()
  })

  test("Composer yolo mouse helper maps plain and shifted activation to scopes", () => {
    const evt = (shift: boolean) => ({ modifiers: { shift, alt: false, ctrl: false } })
    expect(yoloScopeFromMouse(evt(false))).toBe("session")
    expect(yoloScopeFromMouse(evt(true))).toBe("global")
  })

  test("wire/config typing accepts yolo status, response scope, and upstream approval modes", () => {
    const info: SessionInfo = { yolo: true }
    const res: ConfigSetResponse = { scope: "global", info }
    expect(res.info?.yolo).toBe(true)

    const mode = buildFields({ approvals: { mode: "smart" } }).find(f => f.key === "approvals.mode")
    expect(mode?.options).toEqual(["manual", "smart", "off"])
    expect(check("approvals.mode", "manual")).toBe(null)
    expect(check("approvals.mode", "smart")).toBe(null)
    expect(check("approvals.mode", "off")).toBe(null)
    expect(check("approvals.mode", "yolo")).toContain("manual | smart | off")
  })
})
