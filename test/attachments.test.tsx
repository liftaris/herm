import { describe, expect, test } from "bun:test"
import { act } from "react"
import { BoxRenderable, TextRenderable, type Renderable } from "@opentui/core"
import { mount, mountNode, until, MockGateway } from "./harness"
import { Composer } from "../src/components/chat/Composer"
import { LOCAL_COMMANDS } from "../src/app/slashCommands"

function walk(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap(walk)]
}

describe("composer attachments", () => {
  test("clipboard routing detaches authoritatively before image-only submit", async () => {
    let n = 0
    const gw = new MockGateway()
    gw.expect$("clipboard.paste", () => {
      n++
      return { attached: true, path: `/tmp/image-${n}.png`, name: `image-${n}.png`, count: n }
    }, { min: 2, max: 2 })
    gw.expect$("image.detach", () => ({ detached: true, count: 1 }), {
      match: params => params.path === "/tmp/image-2.png",
    })
    gw.expect$("prompt.submit", () => ({ status: "accepted" }), {
      match: params => params.text === "",
    })

    await using t = await mount({ gw })

    act(() => t.keys.pressKey("v", { ctrl: true }))
    await until(t, () => t.frame().includes("image-1.png"))
    act(() => t.keys.pressKey("v", { ctrl: true }))
    await until(t, () => t.frame().includes("image-2.png"))

    act(() => t.keys.pressBackspace())
    await until(t, () => !t.frame().includes("image-2.png"))
    expect(t.frame()).toContain("image-1.png")
    expect(t.gw.last("image.detach")?.params.path).toBe("/tmp/image-2.png")

    act(() => t.keys.pressEnter())
    await until(t, () => t.gw.last("prompt.submit") !== undefined)
    expect(t.gw.last("prompt.submit")?.params.text).toBe("")
  })

  test("detach failure preserves the chip and surfaces the gateway error", async () => {
    const gw = new MockGateway()
    gw.expect$("clipboard.paste", () => ({
      attached: true,
      path: "/tmp/image-1.png",
      name: "image-1.png",
      count: 1,
    }))
    gw.expect$("image.detach", () => { throw new Error("session not found") }, {
      match: params => params.path === "/tmp/image-1.png",
    })

    await using t = await mount({ gw })

    act(() => t.keys.pressKey("v", { ctrl: true }))
    await until(t, () => t.frame().includes("image-1.png"))
    act(() => t.keys.pressBackspace())
    await until(t, () => t.frame().includes("session not found"))

    expect(t.frame()).toContain("image-1.png")
    expect(t.gw.last("prompt.submit")).toBeUndefined()
  })

  test("mid-line backspace edits text instead of detaching", async () => {
    const gw = new MockGateway()
    gw.expect$("clipboard.paste", () => ({
      attached: true,
      path: "/tmp/image-1.png",
      name: "image-1.png",
      count: 1,
    }))
    gw.expect$("prompt.submit", () => ({ status: "accepted" }), {
      match: params => params.text === "b",
    })

    await using t = await mount({ gw })

    act(() => t.keys.pressKey("v", { ctrl: true }))
    await until(t, () => t.frame().includes("image-1.png"))
    await act(async () => { await t.keys.typeText("ab") })
    await act(async () => { t.keys.pressArrow("left") })
    act(() => t.keys.pressBackspace())
    await t.settle()
    expect(t.gw.last("image.detach")).toBeUndefined()
    expect(t.frame()).toContain("image-1.png")

    act(() => t.keys.pressEnter())
    await until(t, () => t.gw.last("prompt.submit") !== undefined)
    expect(t.gw.last("prompt.submit")?.params.text).toBe("b")
  })

  test("pending detach blocks same-tick stale submit", async () => {
    let done!: (v: unknown) => void
    const gw = new MockGateway()
    gw.expect$("clipboard.paste", () => ({
      attached: true,
      path: "/tmp/image-1.png",
      name: "image-1.png",
      count: 1,
    }))
    gw.expect$("image.detach", () => new Promise(r => { done = r }), {
      match: params => params.path === "/tmp/image-1.png",
    })
    gw.allow$("prompt.submit", () => ({ status: "accepted" }), {
      match: params => params.text === "hello",
      max: 1,
    })

    await using t = await mount({ gw })

    act(() => t.keys.pressKey("v", { ctrl: true }))
    await until(t, () => t.frame().includes("image-1.png"))
    await act(async () => { await t.keys.typeText("hello") })
    act(() => t.keys.pressKey("HOME"))
    await t.settle()
    act(() => {
      t.keys.pressBackspace()
      t.keys.pressEnter()
    })
    await t.settle()

    expect(t.gw.last("image.detach")?.params.path).toBe("/tmp/image-1.png")
    expect(t.gw.last("prompt.submit")).toBeUndefined()
    await act(async () => { done({ detached: true, count: 0 }) })
    await until(t, () => !t.frame().includes("image-1.png"))

    act(() => t.keys.pressEnter())
    await until(t, () => t.gw.last("prompt.submit") !== undefined)
    expect(t.gw.last("prompt.submit")?.params.text).toBe("hello")
  })

  test("attachment tray remains within the composer border", async () => {
    await using t = await mountNode(
      <box flexDirection="column" flexGrow={1} width="100%" height="100%">
        <box flexGrow={1} />
        <Composer
          focused canSubmitPrompt={true} ready streaming={false} cmds={LOCAL_COMMANDS}
          attachments={[{ attached: true, path: "/tmp/inside.png", name: "inside.png", count: 1 }]}
          onSend={() => {}} onSlash={() => {}}
        />
      </box>,
      { width: 120, height: 30 },
    )
    await until(t, () => walk(t.renderer.root).some(node =>
      node instanceof TextRenderable && node.plainText.includes("inside.png")))

    const nodes = walk(t.renderer.root)
    const border = nodes.find((node): node is BoxRenderable =>
      node instanceof BoxRenderable && node.border === true)
    const chip = nodes.find((node): node is TextRenderable =>
      node instanceof TextRenderable && node.plainText.includes("inside.png"))

    expect(border).toBeDefined()
    expect(chip).toBeDefined()
    expect(chip!.screenX).toBeGreaterThan(border!.screenX)
    expect(chip!.screenX + chip!.width).toBeLessThan(border!.screenX + border!.width)
    expect(chip!.screenY).toBeGreaterThan(border!.screenY)
    expect(chip!.screenY + chip!.height).toBeLessThan(border!.screenY + border!.height)
  })
})
