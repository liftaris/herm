import { expect, test } from "bun:test"
import { act } from "react"
import { useGatewayReady } from "../src/context/gateway"
import { mount, mountNode, until, MockGateway } from "./harness"

const Ready = () => <text>{useGatewayReady() ? "gateway ready" : "gateway down"}</text>

test("gateway process exit clears provider readiness", async () => {
  const gw = new MockGateway()
  const t = await mountNode(<Ready />, { gw })
  await until(t, () => t.frame().includes("gateway ready"))

  act(() => gw.emit("exit", 7))
  await until(t, () => t.frame().includes("gateway down"))
  expect(t.frame()).not.toContain("gateway ready")
  t.destroy()
})

test("gateway process exit surfaces in the app transcript", async () => {
  const gw = new MockGateway()
  const t = await mount({ gw, launch: { mode: "new", splash: false } })
  await until(t, () => t.frame().includes("Ready"))

  act(() => gw.push({ type: "voice.status", payload: { state: "listening" } }))
  await until(t, () => t.frame().includes("recording"))

  act(() => gw.emit("exit", 7))
  await until(t, () => t.frame().includes("gateway exited (7)"))
  expect(t.frame()).not.toContain("● Ready")
  expect(t.frame()).not.toContain("recording")
  t.destroy()
})

test("unexpected gateway exit restarts with bounded backoff", async () => {
  class CountingGateway extends MockGateway {
    starts = 0
    override start() { this.starts++; super.start() }
  }
  const gw = new CountingGateway()
  const t = await mountNode(<Ready />, { gw })
  await until(t, () => gw.starts === 1 && t.frame().includes("gateway ready"))

  gw.ok = false
  act(() => gw.emit("exit", 7))
  await until(t, () => t.frame().includes("gateway down"))
  await until(t, () => gw.starts === 2 && t.frame().includes("gateway ready"), 1000)
  t.destroy()
})

test("unexpected gateway restart resumes the active session", async () => {
  const resumed: string[] = []
  const gw = new MockGateway({
    "session.resume": p => {
      resumed.push(p.session_id as string)
      return { session_id: p.session_id, messages: [] }
    },
  })
  const t = await mount({ gw, launch: { mode: "new", splash: false } })
  await until(t, () => t.frame().includes("Ready"))
  act(() => gw.emit("exit", 7))
  await until(t, () => resumed.length > 0, 1000)
  expect(resumed).toEqual(["test-sid"])
  t.destroy()
})

test("explicit resume restart preserves the active session", async () => {
  const resumed: string[] = []
  const gw = new MockGateway({
    "session.resume": p => {
      resumed.push(p.session_id as string)
      return { session_id: p.session_id, messages: [] }
    },
  })
  const t = await mount({ gw, launch: { mode: "new", splash: false } })
  await until(t, () => t.frame().includes("Ready"))
  act(() => gw.emit("restart", "resume"))
  act(() => gw.push({ type: "gateway.ready" }))
  await until(t, () => resumed.length > 0)
  expect(resumed).toEqual(["test-sid"])
  t.destroy()
})
