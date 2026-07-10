import { describe, expect, test } from "bun:test"
import { act } from "react"
import { previewStrategy } from "../src/utils/terminal-image"
import { mount, mountNode, until } from "./harness"
import { Composer } from "../src/components/chat/Composer"
import { LOCAL_COMMANDS } from "../src/app/slashCommands"

describe("composer: image attachments (D4+D7)", () => {
  test("composer images use the shared preview strategy", () => {
    expect(previewStrategy({ path: "/tmp/clip_1.png", exists: true, chafa: true })).toEqual({
      kind: "chafa",
      reason: "chafa-supported",
    })
  })

  test("Ctrl+V → clipboard.paste → chip renders; clears on send", async () => {
    const t = await mount({
      handlers: {
        "clipboard.paste": () => ({
          attached: true, path: "/tmp/clip_1.png", name: "clip_1.png",
          count: 1, width: 800, height: 600, token_estimate: 1105,
        }),
      },
    })
    await until(t, () => t.frame().includes("Ready"))

    act(() => t.keys.pressKey("v", { ctrl: true }))
    await until(t, () => t.gw.last("clipboard.paste") !== undefined)
    await until(t, () => t.frame().includes("clip_1.png"))

    const f = t.frame()
    expect(f).not.toContain(" img ")
    expect(f).not.toContain("800×600")
    expect(f).not.toContain("~1.1kt")
    expect(f).not.toContain("⌫ to detach")
    // stopPropagation: <input> didn't receive the literal "v"
    expect(f).not.toMatch(/> v\b/)

    // send → pre-send chip clears from the composer tray (gateway drains
    // attached_images on prompt.submit). The path echoes into the user's
    // transcript as a MEDIA: line so ChafaImage renders it inline (falls
    // back to MediaChip when chafa is absent or the file is missing —
    // this test uses a /tmp path that doesn't exist, so badge renders).
    await act(async () => { await t.keys.typeText("describe this") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.gw.last("prompt.submit") !== undefined)
    // Wire carries the raw user text; MEDIA: echo is client-only so the
    // gateway's text-mode image routing owns the analysis-block prefix
    // without duplicating the path. See app.tsx:send for rationale.
    expect(t.gw.last("prompt.submit")?.params.text).toBe("describe this")
    // Pre-send tray metadata is gone.
    await until(t, () => !t.frame().includes("~1.1kt"))
    // But the transcript MEDIA echo is visible: basename in the user turn.
    expect(t.frame()).toContain("clip_1.png")
    t.destroy()
  })

  test("Ctrl+V with no clipboard image → toast, no chip", async () => {
    const t = await mount({
      handlers: {
        "clipboard.paste": () => ({ attached: false, message: "No image found in clipboard" }),
      },
    })
    await until(t, () => t.frame().includes("Ready"))

    act(() => t.keys.pressKey("v", { ctrl: true }))
    await until(t, () => t.gw.last("clipboard.paste") !== undefined)
    await until(t, () => t.frame().includes("No image found in clipboard"))
    expect(t.frame()).not.toContain(" img ")
    t.destroy()
  })

  test("multiple image attachments stay visible", async () => {
    let n = 0
    const t = await mount({
      handlers: {
        "clipboard.paste": () => {
          n++
          return { attached: true, path: `/tmp/i${n}.png`, name: `i${n}.png`, count: n }
        },
      },
    })
    await until(t, () => t.frame().includes("Ready"))

    act(() => t.keys.pressKey("v", { ctrl: true }))
    await until(t, () => t.frame().includes("i1.png"))
    act(() => t.keys.pressKey("v", { ctrl: true }))
    await until(t, () => t.frame().includes("i2.png"))

    expect(t.frame()).toContain("i1.png")
    expect(t.frame()).toContain("i2.png")
    t.destroy()
  })

  test("backspace on empty composer detaches last attachment (LIFO)", async () => {
    let n = 0
    const t = await mount({
      handlers: {
        "clipboard.paste": () => {
          n++
          return { attached: true, path: `/tmp/i${n}.png`, name: `i${n}.png`, count: n }
        },
      },
    })
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.keys.pressKey("v", { ctrl: true }))
    await until(t, () => t.frame().includes("i1.png"))
    act(() => t.keys.pressKey("v", { ctrl: true }))
    await until(t, () => t.frame().includes("i2.png"))

    // First backspace peels i2 (last attached).
    act(() => t.keys.pressBackspace())
    await until(t, () => !t.frame().includes("i2.png"))
    expect(t.frame()).toContain("i1.png")
    // Second backspace peels i1.
    act(() => t.keys.pressBackspace())
    await until(t, () => !t.frame().includes("i1.png"))
    // Third backspace on empty composer + empty tray → no-op (not a crash).
    act(() => t.keys.pressBackspace())
    await t.settle()
    t.destroy()
  })

  test("backspace mid-text edits text, not attachments", async () => {
    const t = await mount({
      handlers: {
        "clipboard.paste": () => ({
          attached: true, path: "/tmp/clip_1.png", name: "clip_1.png", count: 1,
        }),
      },
    })
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.keys.pressKey("v", { ctrl: true }))
    await until(t, () => t.frame().includes("clip_1.png"))
    await act(async () => { await t.keys.typeText("hi") })
    // Backspace with "hi" in buffer → textarea eats it (now "h").
    act(() => t.keys.pressBackspace())
    await t.settle()
    // Chip still there.
    expect(t.frame()).toContain("clip_1.png")
    t.destroy()
  })

  test("backspace at line start detaches even when composer has text", async () => {
    const t = await mount({
      handlers: {
        "clipboard.paste": () => ({
          attached: true, path: "/tmp/clip_1.png", name: "clip_1.png", count: 1,
        }),
      },
    })
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.keys.pressKey("v", { ctrl: true }))
    await until(t, () => t.frame().includes("clip_1.png"))
    await act(async () => { await t.keys.typeText("hi") })
    act(() => t.keys.pressKey("HOME"))
    await t.settle()

    act(() => t.keys.pressBackspace())
    await until(t, () => !t.frame().includes("clip_1.png"))
    expect(t.frame()).toContain("hi")
    t.destroy()
  })

  test("Enter with empty buffer + attachment → sends empty prompt with image", async () => {
    const t = await mount({
      handlers: {
        "clipboard.paste": () => ({
          attached: true, path: "/tmp/clip_1.png", name: "clip_1.png", count: 1,
          width: 800, height: 600, token_estimate: 1105,
        }),
      },
    })
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.keys.pressKey("v", { ctrl: true }))
    await until(t, () => t.frame().includes("clip_1.png"))
    expect(t.frame()).not.toContain("⌫ to detach")
    // Enter with no typed text — should still submit (gateway has the image).
    act(() => t.keys.pressEnter())
    await until(t, () => t.gw.last("prompt.submit") !== undefined)
    expect(t.gw.last("prompt.submit")?.params.text).toBe("")
    // Pre-send tray is gone; chip still appears in the transcript MEDIA
    // echo, which is expected.
    act(() => t.gw.push({ type: "message.start" }))
    act(() => t.gw.push({ type: "message.complete", payload: { status: "complete", text: "done" } }))
    await until(t, () => t.frame().includes("Ready"))
    t.destroy()
  })

  test("empty bracketed paste → probes clipboard for image", async () => {
    // Windows Terminal surfaces an image-only clipboard as ESC[200~ESC[201~.
    const t = await mount({
      handlers: {
        "clipboard.paste": () => ({
          attached: true, path: "/tmp/wt.png", name: "wt.png", count: 1,
        }),
      },
    })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.pasteBracketedText("") })
    await until(t, () => t.gw.last("clipboard.paste") !== undefined)
    await until(t, () => t.frame().includes("wt.png"))
    t.destroy()
  })

  test("Enter with empty buffer AND no attachments → no submit (still a no-op)", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.keys.pressEnter())
    await t.settle()
    expect(t.gw.last("prompt.submit")).toBeUndefined()
    t.destroy()
  })

  test("attachments render inside the composer border", async () => {
    const t = await mount({
      handlers: {
        "clipboard.paste": () => ({
          attached: true, path: "/tmp/inside.png", name: "inside.png",
          count: 1, width: 640, height: 480,
        }),
      },
    })
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.keys.pressKey("v", { ctrl: true }))
    await until(t, () => t.frame().includes("inside.png"))

    const rows = t.frame().split("\n")
    const top = rows.findIndex(l => l.startsWith("┌"))
    const img = rows.findIndex(l => l.includes("inside.png"))
    const bot = rows.findIndex((l, i) => i > top && l.startsWith("└"))
    expect(top).toBeGreaterThan(-1)
    expect(img).toBeGreaterThan(top)
    expect(img).toBeLessThan(bot)
    t.destroy()
  })

  test("path-backed non-image attachment renders only a file chip", async () => {
    const t = await mountNode(
      <box flexDirection="column" flexGrow={1} width="100%" height="100%">
        <box flexGrow={1} />
        <Composer
          focused canSubmitPrompt={true} ready streaming={false} cmds={LOCAL_COMMANDS}
          attachments={[{ attached: true, path: "/tmp/report.pdf", name: "report.pdf", count: 1 }]}
          onSend={() => {}} onSlash={() => {}}
        />
      </box>,
      { width: 120, height: 30 },
    )
    await until(t, () => t.frame().includes("report.pdf"))

    expect(t.frame()).toContain(" file ")
    expect(t.frame()).not.toContain(" img ")
    t.destroy()
  })

  test("attachment overflow counts only attachments hidden from previews and chips", async () => {
    const t = await mountNode(
      <box flexDirection="column" flexGrow={1} width="100%" height="100%">
        <box flexGrow={1} />
        <Composer
          focused canSubmitPrompt={true} ready streaming={false} cmds={LOCAL_COMMANDS}
          attachments={[
            { attached: true, path: "/tmp/one.pdf", name: "one.pdf", count: 1 },
            { attached: true, path: "/tmp/two.txt", name: "two.txt", count: 2 },
            { attached: true, path: "/tmp/three.png", name: "three.png", count: 3 },
          ]}
          onSend={() => {}} onSlash={() => {}}
        />
      </box>,
      { width: 120, height: 30 },
    )
    await until(t, () => t.frame().includes("one.pdf") && t.frame().includes("two.txt"))

    expect(t.frame()).toContain("three.png")
    expect(t.frame()).not.toContain("+1")
    t.destroy()
  })
})
