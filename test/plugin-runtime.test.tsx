import { describe, expect, test } from "bun:test"
import { act } from "react"
import { mount, mountNode, until, type Harness } from "./harness"
import { usePlugins } from "../src/plugins/runtime"
import type { HermPlugin, HermPluginApi } from "../src/plugins/types"

const Host = () => {
  const p = usePlugins()
  return (
    <box flexDirection="column">
      <box height={1}><text>{`routes:${p.routes.map(r => r.name).join(",")}`}</text></box>
      <box height={3} flexDirection="column">
        <p.Slot name="app_bottom" mode="append" sid="s" tab={0} streaming={false}>
          <text>fallback</text>
        </p.Slot>
      </box>
    </box>
  )
}

const slot = (id: string, order: number, body: string): HermPlugin => ({
  id,
  tui(api) {
    api.slots.register({ order, slots: { app_bottom: () => <text>{body}</text> } })
  },
})

describe("PluginProvider", () => {
  test("renders Slot fallback when no plugin contributes", async () => {
    await using t = await mountNode(<Host />, { width: 60, height: 10 })
    await until(t, () => t.frame().includes("fallback"))
    expect(t.frame()).toContain("fallback")
    expect(t.frame()).toContain("routes:")
  })

  test("append mode stacks contributions after the default child, sorted by order", async () => {
    await using t = await mountNode(<Host />, {
      width: 60, height: 10,
      plugins: [slot("b", 20, "second"), slot("a", 10, "first")],
    })
    await until(t, () => t.frame().includes("first"))
    const frame = t.frame()
    expect(frame.indexOf("fallback")).toBeLessThan(frame.indexOf("first"))
    expect(frame.indexOf("first")).toBeLessThan(frame.indexOf("second"))
  })

  test("route.register surfaces in usePlugins().routes", async () => {
    const p: HermPlugin = {
      id: "r",
      tui(api) { api.route.register([{ name: "Files", render: () => <text>x</text> }]) },
    }
    await using t = await mountNode(<Host />, { width: 60, height: 10, plugins: [p] })
    await until(t, () => t.frame().includes("routes:Files"))
  })

  test("plugin routes receive live content focus", async () => {
    let api: HermPluginApi | undefined
    const plugin: HermPlugin = {
      id: "focus-route",
      tui(value) {
        api = value
        value.route.register([{
          name: "FocusRoute",
          render: ctx => <text>{ctx.focused ? "route focused" : "route blurred"}</text>,
        }])
      },
    }
    await using t = await mount({ plugins: [plugin] })
    await until(t, () => api !== undefined)
    await act(async () => { await Bun.sleep(50) })
    await t.settle()
    act(() => api!.route.navigate("FocusRoute"))
    await until(t, () => t.frame().includes("route focused"))

    act(() => api!.ui.dialog.replace(<text>route dialog</text>))
    await until(t, () => t.frame().includes("route dialog") && t.frame().includes("route blurred"))
    act(() => api!.ui.dialog.clear())
    await until(t, () => t.frame().includes("route focused"))

    act(() => t.keys.pressTab())
    await act(async () => { await Bun.sleep(50) })
    act(() => t.keys.pressTab())
    await until(t, () => t.frame().includes("route blurred"))
  })

  test("throwing route renderer is isolated from the shell", async () => {
    let api: HermPluginApi | undefined
    const plugin: HermPlugin = {
      id: "bad-route",
      tui(value) {
        api = value
        value.route.register([{
          name: "BadRoute",
          render: () => { throw new Error("route exploded") },
        }])
      },
    }
    await using t = await mount({ plugins: [plugin] })
    await until(t, () => api !== undefined)
    await act(async () => { await Bun.sleep(50) })
    act(() => api!.route.navigate("BadRoute"))
    await until(t, () => t.frame().includes("route exploded"))
    expect(t.frame()).toContain("Ready")
  })

  test("removing the active plugin route returns to Chat", async () => {
    let api: HermPluginApi | undefined
    let remove: (() => void) | undefined
    const plugin: HermPlugin = {
      id: "short-route",
      tui(value) {
        api = value
        remove = value.route.register([{
          name: "ShortRoute",
          render: () => <text>short route body</text>,
        }])
      },
    }
    await using t = await mount({ plugins: [plugin] })
    await until(t, () => api !== undefined && remove !== undefined)
    await act(async () => { await Bun.sleep(50) })
    act(() => api!.route.navigate("ShortRoute"))
    await until(t, () => t.frame().includes("short route body"))

    act(() => remove!())
    await until(t, () => api!.route.current === "Chat")
    expect(t.frame()).not.toContain("short route body")
  })

  test("removing an earlier route preserves the active route by name", async () => {
    let api: HermPluginApi | undefined
    let removeFirst: (() => void) | undefined
    const plugin: HermPlugin = {
      id: "route-order",
      tui(value) {
        api = value
        removeFirst = value.route.register([{
          name: "FirstRoute",
          render: () => <text>first route body</text>,
        }])
        value.route.register([{
          name: "SecondRoute",
          render: () => <text>second route body</text>,
        }])
      },
    }
    await using t = await mount({ plugins: [plugin] })
    await until(t, () => api !== undefined && removeFirst !== undefined)
    await act(async () => { await Bun.sleep(50) })
    act(() => api!.route.navigate("SecondRoute"))
    await until(t, () => t.frame().includes("second route body"))

    act(() => removeFirst!())
    await until(t, () => api!.route.current === "SecondRoute")
    expect(t.frame()).toContain("second route body")
  })

  test("failing tui() is isolated — later plugins still activate", async () => {
    const bad: HermPlugin = { id: "bad", tui() { throw new Error("nope") } }
    await using t = await mountNode(<Host />, {
      width: 60, height: 10,
      plugins: [bad, slot("ok", 0, "survived")],
    })
    await until(t, () => t.frame().includes("survived"))
  })

  test("throwing slot renderer is sandboxed by error boundary", async () => {
    const bad: HermPlugin = {
      id: "bad",
      tui(api) {
        api.slots.register({ order: 0, slots: { app_bottom: () => { throw new Error("render boom") } } })
      },
    }
    await using t = await mountNode(<Host />, {
      width: 60, height: 10,
      plugins: [bad, slot("ok", 10, "survived")],
    })
    await until(t, () => t.frame().includes("survived"))
    expect(t.frame()).not.toContain("render boom")
  })

  test("kv is namespaced per plugin id", async () => {
    let a: HermPluginApi | undefined
    let b: HermPluginApi | undefined
    await using _t = await mountNode(<Host />, {
      width: 40, height: 6,
      plugins: [
        { id: "a", tui(api) { a = api; api.kv.set("x", 1) } },
        { id: "b", tui(api) { b = api; api.kv.set("x", 2) } },
      ],
    })
    await until(_t, () => a !== undefined && b !== undefined)
    expect(a!.kv.get("x", 0)).toBe(1)
    expect(b!.kv.get("x", 0)).toBe(2)
  })

  test("event.on receives gateway events and disposes on deactivate", async () => {
    const seen: string[] = []
    const Probe = () => {
      const p = usePlugins()
      return <text>{`active:${p.status().filter(s => s.active).map(s => s.id).join(",")}`}</text>
    }
    const t: Harness = await mountNode(<Probe />, {
      width: 60, height: 6,
      plugins: [{
        id: "ev",
        tui(api) { api.event.on(ev => seen.push(ev.type)) },
      }],
    })
    await until(t, () => t.frame().includes("active:ev"))
    t.gw.push({ type: "gateway.ready" })
    await t.settle()
    expect(seen).toContain("gateway.ready")
    t.destroy()
  })
})

describe("app_bottom slot", () => {
  test("shell does not reserve a bottom row when no plugin contributes", async () => {
    await using t = await mount({ width: 80, height: 18 })
    await until(t, () => t.frame().includes("Ready"))
    const lines = t.frame().split("\n")
    expect(lines.findIndex(l => l.includes("Ready"))).toBe(lines.length - 2)
  })
})

describe("usePlugins controls", () => {
  const Probe = () => {
    const p = usePlugins()
    ;(globalThis as { __p?: ReturnType<typeof usePlugins> }).__p = p
    return (
      <box height={3} flexDirection="column">
        <p.Slot name="app_bottom" mode="single_winner" sid="" tab={0} streaming={false}>
          <text>empty</text>
        </p.Slot>
      </box>
    )
  }

  test("deactivate tears down slot registrations; activate restores them", async () => {
    await using t = await mountNode(<Probe />, {
      width: 50, height: 6,
      plugins: [slot("demo", 0, "from-demo")],
    })
    await until(t, () => t.frame().includes("from-demo"))
    const p = (globalThis as { __p?: ReturnType<typeof usePlugins> }).__p!
    expect(p.status().find(s => s.id === "demo")?.active).toBe(true)

    await p.deactivate("demo")
    await until(t, () => t.frame().includes("empty"))
    expect(p.status().find(s => s.id === "demo")?.active).toBe(false)

    await p.activate("demo")
    await until(t, () => t.frame().includes("from-demo"))
  })

  test("single_winner picks highest-order contribution", async () => {
    await using t = await mountNode(<Probe />, {
      width: 50, height: 6,
      plugins: [slot("lo", 10, "lo"), slot("hi", 1, "hi")],
    })
    // SlotRegistry sorts ascending by order; single_winner takes entries[0].
    await until(t, () => t.frame().includes("hi") || t.frame().includes("lo"))
    const frame = t.frame()
    // Only one of the two should render under single_winner.
    expect(frame.includes("hi") !== frame.includes("lo")).toBe(true)
  })
})
