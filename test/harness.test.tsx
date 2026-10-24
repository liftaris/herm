import { describe, expect, test } from "bun:test"
import { act, useEffect } from "react"
import { MockGateway, mountNode } from "./harness"
import { useGateway } from "../src/context/gateway"

class ProbeGateway extends MockGateway {
  killed = false
  kill() { this.killed = true; super.kill() }
}

describe("MockGateway strictness", () => {
  test("audit mode records unknown traffic without changing the compatibility response", async () => {
    const gw = new MockGateway({}, { mode: "audit" })
    expect(await gw.request<Record<string, never>>("unknown.audit", { value: 1 })).toEqual({})
    expect(() => gw.assert()).toThrow("unknown.audit")
  })

  test("strict mode remains failing when product code catches the rejection", async () => {
    const gw = new MockGateway({}, { mode: "strict" })
    await gw.request("unknown.strict", { value: 2 }).catch(() => {})
    expect(() => gw.assert()).toThrow("unknown.strict")
  })

  test("known non-boot RPCs still require an explicit declaration", async () => {
    const gw = new MockGateway({}, { mode: "strict" })
    await gw.request("session.close", { session_id: "sid" }).catch(() => {})
    expect(() => gw.assert()).toThrow("session.close")
  })

  test("declared rejection is a product failure path, not unknown traffic", async () => {
    const gw = new MockGateway({}, { mode: "strict" })
    gw.on$("known.failure", () => { throw new Error("declared failure") })
    await expect(gw.request("known.failure")).rejects.toThrow("declared failure")
    expect(() => gw.assert()).not.toThrow()
  })

  test("required expectations validate parameters, counts, and consumption", async () => {
    const unused = new MockGateway({}, { mode: "strict" })
    unused.expect$("config.set", () => ({ value: "on" }), {
      match: params => params.key === "verbose",
    })
    expect(() => unused.assert()).toThrow("config.set was not called")

    const gw = new MockGateway({}, { mode: "strict" })
    gw.expect$("config.set", () => ({ value: "on" }), {
      match: params => params.key === "verbose",
      max: 1,
    })
    expect(await gw.request<{ value: string }>("config.set", { key: "verbose" })).toEqual({ value: "on" })
    expect(() => gw.assert()).not.toThrow()
    await gw.request("config.set", { key: "verbose" }).catch(() => {})
    expect(() => gw.assert()).toThrow("config.set exceeded 1 call")

    const mismatch = new MockGateway({}, { mode: "strict" })
    mismatch.expect$("config.set", () => ({}), { match: params => params.key === "verbose" })
    await mismatch.request("config.set", { key: "quiet" }).catch(() => {})
    expect(() => mismatch.assert()).toThrow("parameters did not match")
  })

  test("optional allowances are bounded and validate their bounds", async () => {
    const gw = new MockGateway({}, { mode: "strict" })
    gw.allow$("telemetry.tick", () => ({}), { match: params => params.kind === "tick" })
    expect(() => gw.assert()).not.toThrow()
    await gw.request("telemetry.tick", { kind: "tick" })
    expect(() => gw.assert()).not.toThrow()
    await gw.request("telemetry.tick", { kind: "tick" }).catch(() => {})
    expect(() => gw.assert()).toThrow("telemetry.tick exceeded 1 call")

    const invalid = new MockGateway({}, { mode: "strict" })
    expect(() => invalid.allow$("bad", () => ({}), { max: Infinity }))
      .toThrow("invalid bounds")
  })

  test("mount cleanup surfaces a caught unknown request", async () => {
    let unmounted = false
    const Probe = () => {
      const gw = useGateway()
      useEffect(() => {
        void gw.request("caught.by.product").catch(() => {})
        return () => { unmounted = true }
      }, [gw])
      return <text>probe</text>
    }
    const gw = new ProbeGateway({}, { mode: "strict" })
    await expect(mountNode(<Probe />, { gw })).rejects.toThrow("caught.by.product")
    expect(gw.killed).toBe(true)
    expect(unmounted).toBe(true)
  })

  test("post-mount settlement cleans up before surfacing unknown traffic", async () => {
    const gw = new ProbeGateway({}, { mode: "strict" })
    const t = await mountNode(<text>ready</text>, { gw })
    await gw.request("late.unknown").catch(() => {})
    await expect(t.settle()).rejects.toThrow("late.unknown")
    expect(gw.killed).toBe(true)
  })
})

test("frame readers retain the displayed frame while the next frame is painting", async () => {
  const frames: string[] = []
  const failures: unknown[] = []
  let observe = () => {}
  await using t = await mountNode(<box renderBefore={() => observe()}><text>displayed marker</text></box>)
  observe = () => {
    try { frames.push(t.frame()); t.spans() }
    catch (error) { failures.push(error) }
  }
  act(() => t.renderer.requestRender())
  await t.settle()
  expect(frames.length + failures.length).toBeGreaterThan(0)
  expect(failures).toEqual([])
  expect(frames.every(frame => frame.includes("displayed marker"))).toBe(true)
})
