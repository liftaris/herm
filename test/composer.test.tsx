import { describe, expect, test } from "bun:test"
import { act, createRef, useState } from "react"
import { mountNode, until, MockGateway, type Harness } from "./harness"
import { Composer, type ComposerHandle } from "../src/components/chat/Composer"
import { acceptCompletion } from "../src/app/useCompletion"
import * as prefs from "../src/context/preferences"
import type { SlashCommand } from "../src/app/slashCommands"
import { LOCAL_COMMANDS } from "../src/app/slashCommands"
import { atWordAt } from "../src/app/useAtRefPopover"

async function setup(gw = new MockGateway()) {
  const ref = createRef<ComposerHandle>()
  const sent: string[] = []
  const slashed: SlashCommand[] = []
  // Mirror app layout: Composer pinned to bottom of a tall column so
  // its absolute-positioned popover (bottom={4}) has room to render
  // upward into visible frame space.
  const t: Harness = await mountNode(
    <box flexDirection="column" flexGrow={1} width="100%" height="100%">
      <box flexGrow={1} />
      <Composer
        ref={ref}
        focused canSubmitPrompt={true} ready streaming={false} cmds={LOCAL_COMMANDS}
        onSend={m => sent.push(m)} onSlash={c => slashed.push(c)}
      />
    </box>,
    { gw, width: 120, height: 30 },
  )
  await until(t, () => t.frame().includes("Ready"))
  return { t, ref, sent, slashed }
}

function cmd(name: string, category = "Command"): SlashCommand {
  return {
    name,
    category,
    description: `${name} command`,
    aliases: [],
    argsHint: "",
    subcommands: [],
    source: "command",
    target: "gateway",
  }
}

async function withCommands(cmds: ReadonlyArray<SlashCommand>) {
  const ref = createRef<ComposerHandle>()
  const slashed: SlashCommand[] = []
  const t: Harness = await mountNode(
    <box flexDirection="column" flexGrow={1} width="100%" height="100%">
      <box flexGrow={1} />
      <Composer
        ref={ref}
        focused canSubmitPrompt={true} ready streaming={false} cmds={cmds}
        onSend={() => {}} onSlash={c => slashed.push(c)}
      />
    </box>,
    { width: 120, height: 30 },
  )
  await until(t, () => t.frame().includes("Ready"))
  return { t, ref, slashed }
}

describe("composer", () => {
  test("type + Enter sends and clears", async () => {
    const { t, ref, sent } = await setup()
    await act(async () => { await t.keys.typeText("hello there") })
    await t.settle()
    expect(ref.current?.value()).toBe("hello there")
    expect(t.frame()).toContain("hello there")

    act(() => t.keys.pressEnter())
    await t.settle()
    expect(sent).toEqual(["hello there"])
    expect(ref.current?.value()).toBe("")
    t.destroy()
  })

  test("Shift+Enter inserts newline; Enter submits the multi-line buffer", async () => {
    const { t, ref, sent } = await setup()
    await act(async () => { await t.keys.typeText("line one") })
    act(() => t.keys.pressEnter({ shift: true }))
    await t.settle()
    expect(ref.current?.value()).toBe("line one\n")
    expect(ref.current?.lines()).toBe(2)
    expect(sent).toEqual([])

    // box auto-grew (two content rows inside border)
    const rows = t.frame().split("\n")
    const top = rows.findIndex(l => l.startsWith("┌"))
    const bot = rows.findIndex(l => l.startsWith("└"))
    expect(bot - top).toBe(3)

    await act(async () => { await t.keys.typeText("line two") })
    await t.settle()
    expect(ref.current?.value()).toBe("line one\nline two")

    act(() => t.keys.pressEnter())
    await t.settle()
    expect(sent).toEqual(["line one\nline two"])
    expect(ref.current?.value()).toBe("")
    // collapsed back to one row
    const r2 = t.frame().split("\n")
    expect(r2.findIndex(l => l.startsWith("└")) - r2.findIndex(l => l.startsWith("┌"))).toBe(2)
    t.destroy()
  })

  test("input.newline rebind flows to textarea", async () => {
    prefs.set("keys", { "input.newline": "ctrl+o" })
    const { t, ref, sent } = await setup()
    await act(async () => { await t.keys.typeText("a") })
    // Old defaults no longer newline:
    act(() => t.keys.pressEnter({ shift: true }))
    await t.settle()
    expect(ref.current?.value()).toBe("a")
    act(() => t.keys.pressKey("j", { ctrl: true }))
    await t.settle()
    expect(ref.current?.value()).toBe("a")
    // Rebound chord does:
    act(() => t.keys.pressKey("o", { ctrl: true }))
    await t.settle()
    expect(ref.current?.value()).toBe("a\n")
    // Submit still Enter
    await act(async () => { await t.keys.typeText("b") })
    act(() => t.keys.pressEnter())
    await t.settle()
    expect(sent).toEqual(["a\nb"])
    t.destroy()
  })

  test("Ctrl+J and Alt+Enter also insert newline", async () => {
    const { t, ref } = await setup()
    await act(async () => { await t.keys.typeText("a") })
    act(() => t.keys.pressKey("j", { ctrl: true }))
    await t.settle()
    await act(async () => { await t.keys.typeText("b") })
    act(() => t.keys.pressEnter({ meta: true }))
    await t.settle()
    await act(async () => { await t.keys.typeText("c") })
    await t.settle()
    expect(ref.current?.value()).toBe("a\nb\nc")
    t.destroy()
  })

  test("height caps at 6 rows", async () => {
    const { t, ref } = await setup()
    act(() => ref.current?.set(Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n")))
    await t.settle()
    const rows = t.frame().split("\n")
    const top = rows.findIndex(l => l.startsWith("┌"))
    const bot = rows.findIndex(l => l.startsWith("└"))
    expect(bot - top).toBe(7) // 6 content rows + bottom border offset
    expect(ref.current?.lines()).toBe(10)
    t.destroy()
  })

  test("blank submit is ignored", async () => {
    const { t, sent } = await setup()
    await act(async () => { await t.keys.typeText("   ") })
    act(() => t.keys.pressEnter())
    await t.settle()
    expect(sent).toEqual([])
    t.destroy()
  })

  test("history up/down cycles previous sends", async () => {
    const { t, ref } = await setup()
    for (const msg of ["first", "second"]) {
      await act(async () => { await t.keys.typeText(msg) })
      act(() => t.keys.pressEnter())
      await t.settle()
    }
    act(() => ref.current?.historyUp())
    await t.settle()
    expect(ref.current?.value()).toBe("second")
    act(() => ref.current?.historyUp())
    await t.settle()
    expect(ref.current?.value()).toBe("first")
    act(() => ref.current?.historyDown())
    await t.settle()
    expect(ref.current?.value()).toBe("second")
    t.destroy()
  })

  test("history: Up from a later logical line lets the textarea own movement", async () => {
    const { t, ref } = await setup()
    await act(async () => { await t.keys.typeText("seed") })
    act(() => t.keys.pressEnter())
    await t.settle()

    act(() => ref.current?.set("a\nb"))
    await t.settle()
    expect(ref.current?.historyUp()).toBe(false)
    expect(ref.current?.value()).toBe("a\nb")
    t.destroy()
  })

  test("history: Up at first logical line loads previous prompt", async () => {
    const { t, ref } = await setup()
    await act(async () => { await t.keys.typeText("seed") })
    act(() => t.keys.pressEnter())
    await t.settle()

    act(() => ref.current?.set("draft"))
    await t.settle()
    expect(ref.current?.historyUp()).toBe(true)
    await t.settle()
    expect(ref.current?.value()).toBe("seed")
    t.destroy()
  })

  test("ghost completion appears after 2 chars and Tab accepts", async () => {
    const { t, ref } = await setup()
    await act(async () => { await t.keys.typeText("/cl") })
    await t.settle()
    // ghost = "ear" (completes to /clear)
    expect(t.frame()).toContain("/clear")    // popover shows it
    expect(t.frame()).toMatch(/\/cl\s*ear/)   // input + ghost overlay

    act(() => ref.current?.popAccept())
    await t.settle()
    expect(ref.current?.value()).toBe("/clear")
    t.destroy()
  })

  test("popover Enter completes command text and closes before submit", async () => {
    const { t, ref, sent, slashed } = await setup()
    await act(async () => { await t.keys.typeText("/he") })
    await t.settle()
    expect(ref.current?.popOpen()).toBe(true)

    act(() => t.keys.pressEnter())
    await t.settle()
    expect(slashed).toEqual([])
    expect(sent).toEqual([])
    expect(ref.current?.value()).toBe("/help")
    expect(ref.current?.popOpen()).toBe(false)

    act(() => t.keys.pressEnter())
    await t.settle()
    expect(sent).toEqual(["/help"])
    expect(ref.current?.value()).toBe("")
    t.destroy()
  })

  test("slash popover Enter accepts the top rendered candidate", async () => {
    const { t, ref, slashed } = await withCommands([
      cmd("zulu", "Zed"),
      cmd("alpha", "Client"),
    ])
    await act(async () => { await t.keys.typeText("/") })
    await until(t, () => t.frame().includes("/zulu") && t.frame().includes("/alpha"))

    const line = t.frame().split("\n").find(l => /\/(zulu|alpha)\b/.test(l)) ?? ""
    const top = line.match(/\/(zulu|alpha)\b/)?.[1]
    expect(top).toBeDefined()
    act(() => t.keys.pressEnter())
    await t.settle()

    expect(ref.current?.value()).toBe(`/${top!}`)
    expect(ref.current?.popOpen()).toBe(false)
    expect(slashed).toEqual([])
    t.destroy()
  })

  test("slash popover key-repeat keeps one section label inside a bounded viewport", async () => {
    const cmds = Array.from({ length: 32 }, (_, i) => cmd(`skill-${String(i).padStart(2, "0")}`, `Cat ${String(i).padStart(2, "0")}`))
    const { t, ref } = await withCommands(cmds)
    await act(async () => { await t.keys.typeText("/") })
    await until(t, () => t.frame().includes("/skill-00"))

    for (let n = 0; n < 80; n++) act(() => ref.current?.popNav(1))
    await t.settle()

    const lines = t.frame().split("\n")
    const cats = lines.filter(l => /Cat \d\d/.test(l))
    const items = lines.filter(l => /\/skill-\d\d\b/.test(l))
    expect(cats.length).toBe(1)
    expect(items.length).toBeLessThanOrEqual(10)
    expect(t.frame()).toContain("/skill-31")
    t.destroy()
  })

  test("slash token in mixed prose opens popover and accept replaces only token", async () => {
    const { t, ref, slashed } = await setup()
    await act(async () => { await t.keys.typeText("please /cl") })
    await until(t, () => t.frame().includes("/clear"))
    expect(ref.current?.popOpen()).toBe(true)

    act(() => ref.current?.popAccept())
    await t.settle()
    expect(ref.current?.value()).toBe("please /clear")
    expect(ref.current?.popOpen()).toBe(false)
    expect(slashed).toEqual([])
    t.destroy()
  })

  test("slash tokens in paths, URLs, and markdown links do not open popover", async () => {
    for (const text of ["/tmp/file", "https://host/path", "see [label](/clear)"]) {
      const { t, ref } = await setup()
      await act(async () => { await t.keys.typeText(text) })
      await t.settle()
      expect(ref.current?.popOpen()).toBe(false)
      t.destroy()
    }
  })

  test("mixed prose slash command submits as prompt text, not local slash", async () => {
    const { t, sent, slashed } = await setup()
    await act(async () => { await t.keys.typeText("please /clear now") })
    await until(t, () => t.frame().includes("/clear"))
    act(() => t.keys.pressEscape())
    await t.settle()
    act(() => t.keys.pressEnter())
    await t.settle()
    expect(sent).toEqual(["please /clear now"])
    expect(slashed).toEqual([])
    t.destroy()
  })

  test("slash RPC completion in mixed prose preserves suffix", async () => {
    const gw = new MockGateway({
      "complete.slash": p => p.text === "/zz" ? {
        replace_from: 1,
        items: [{ text: "zeta", display: "/zeta", meta: "remote" }],
      } : { items: [] },
    })
    const { t, ref } = await setup(gw)

    await act(async () => { await t.keys.typeText("please /zz") })
    await until(t, () => t.frame().includes("/zeta"))
    expect(t.gw.last("complete.slash")?.params.text).toBe("/zz")

    act(() => t.keys.pressEnter())
    await t.settle()
    expect(ref.current?.value()).toBe("please /zeta ")
    t.destroy()
  })

  test("popover arrows own navigation before composer history", async () => {
    const { t, ref } = await setup()
    await act(async () => { await t.keys.typeText("seed") })
    act(() => t.keys.pressEnter())
    await t.settle()

    await act(async () => { await t.keys.typeText("please /") })
    await until(t, () => t.frame().includes("/clear"))
    act(() => ref.current?.popNav(1))
    await t.settle()
    expect(ref.current?.value()).toBe("please /")
    t.destroy()
  })

  test("popCancel clears input", async () => {
    const { t, ref } = await setup()
    await act(async () => { await t.keys.typeText("/th") })
    await t.settle()
    act(() => ref.current?.popCancel())
    await t.settle()
    expect(ref.current?.value()).toBe("")
    expect(ref.current?.popOpen()).toBe(false)
    t.destroy()
  })

  test("atWordAt: extracts @-word under caret", () => {
    expect(atWordAt("")).toBeNull()
    expect(atWordAt("hello")).toBeNull()
    expect(atWordAt("/help @")).toBeNull()          // slash mode suppresses
    expect(atWordAt("@")).toEqual({ word: "@", start: 0 })
    expect(atWordAt("look at @file:src/a")).toEqual({ word: "@file:src/a", start: 8 })
    expect(atWordAt("foo@bar")).toBeNull()           // not word-initial
    expect(atWordAt("a @b c")).toBeNull()            // caret not at end of @-word
    expect(atWordAt("a @b")).toEqual({ word: "@b", start: 2 })
    // cursor-relative: works mid-buffer and on later lines
    expect(atWordAt("a @b c", 4)).toEqual({ word: "@b", start: 2 })
    expect(atWordAt("a @b c", 3)).toEqual({ word: "@b", start: 2 })
    expect(atWordAt("a @b c", 2)).toEqual({ word: "@b", start: 2 })
    expect(atWordAt("a @b c", 1)).toBeNull()
    expect(atWordAt("line1\n@f here", 8)).toEqual({ word: "@f", start: 6 })
    expect(atWordAt("line1\nx @f", 10)).toEqual({ word: "@f", start: 8 })
  })

  test("trailing path token opens completion popover and Enter inserts", async () => {
    const gw = new MockGateway({
      "complete.path": p => p.word === "src/app" ? { items: [
        { text: "src/app.tsx", display: "src/app.tsx", meta: "file" },
      ] } : { items: [] },
    })
    const { t, ref } = await setup(gw)

    await act(async () => { await t.keys.typeText("read src/app") })
    await until(t, () => t.frame().includes("src/app.tsx"))
    expect(t.gw.last("complete.path")?.params.word).toBe("src/app")
    expect(ref.current?.popOpen()).toBe(true)

    act(() => t.keys.pressEnter())
    await t.settle()
    expect(ref.current?.value()).toBe("read src/app.tsx ")
    t.destroy()
  })

  test("slash RPC completion opens popover and Enter inserts replacement", async () => {
    const gw = new MockGateway({
      "complete.slash": p => p.text === "/zz" ? {
        replace_from: 1,
        items: [{ text: "zeta", display: "/zeta", meta: "remote" }],
      } : { items: [] },
    })
    const { t, ref } = await setup(gw)

    await act(async () => { await t.keys.typeText("/zz") })
    await until(t, () => t.frame().includes("/zeta"))
    expect(t.gw.last("complete.slash")?.params.text).toBe("/zz")
    expect(ref.current?.popOpen()).toBe(true)

    act(() => t.keys.pressEnter())
    await t.settle()
    expect(ref.current?.value()).toBe("/zeta ")
    t.destroy()
  })

  test("completion RPC error shows unavailable row and does not submit", async () => {
    const gw = new MockGateway({
      "complete.path": () => { throw new Error("offline") },
    })
    const { t, ref, sent } = await setup(gw)

    await act(async () => { await t.keys.typeText("see ./bad") })
    await until(t, () => t.frame().includes("completion unavailable"))
    act(() => t.keys.pressEnter())
    await t.settle()
    expect(sent).toEqual([])
    expect(ref.current?.value()).toBe("see ./bad")
    t.destroy()
  })

  test("acceptCompletion preserves suffix for mid-buffer replacement", () => {
    expect(acceptCompletion(
      "please /zz now",
      { text: "zeta", display: "/zeta", meta: "remote" },
      8,
      10,
    )).toBe("please /zeta now")
  })

  test("@ opens atref popover; Tab inserts; Esc dismisses without clearing", async () => {
    const gw = new MockGateway({
      "complete.path": p => {
        if (p.word === "@") return { items: [
          { text: "@diff", display: "@diff", meta: "git diff" },
          { text: "@file:", display: "@file:", meta: "attach file" },
        ] }
        if ((p.word as string).startsWith("@file:")) return { items: [
          { text: "@file:src/", display: "src/", meta: "dir" },
          { text: "@file:README.md", display: "README.md", meta: "" },
        ] }
        return { items: [] }
      },
    })
    const { t, ref, sent } = await setup(gw)

    await act(async () => { await t.keys.typeText("review @") })
    await until(t, () => t.frame().includes("@diff"))
    expect(ref.current?.popOpen()).toBe(true)
    // client-side keywords precede gateway results; gateway's @diff is deduped
    expect(t.frame()).toContain("@staged")
    expect(t.frame()).toContain("@file:")

    // Enter on keyword-with-colon → inserts without trailing space
    // (@file: sits after the 7 fixed keywords)
    for (let n = 0; n < 7; n++) act(() => ref.current?.popNav(1))
    await t.settle()
    act(() => t.keys.pressEnter())
    await t.settle()
    expect(sent).toEqual([]) // did NOT send
    expect(ref.current?.value()).toBe("review @file:")
    await until(t, () => t.gw.last("complete.path")?.params.word === "@file:")
    await until(t, () => t.frame().includes("README.md"))

    // Nav to README, Tab accepts → adds trailing space
    act(() => ref.current?.popNav(1))
    act(() => ref.current?.popAccept())
    await t.settle()
    expect(ref.current?.value()).toBe("review @file:README.md ")
    expect(ref.current?.popOpen()).toBe(false)

    // Dismiss: type @ again, Esc closes but keeps input
    await act(async () => { await t.keys.typeText("and @") })
    await until(t, () => ref.current?.popOpen() === true)
    act(() => ref.current?.popCancel())
    await t.settle()
    expect(ref.current?.popOpen()).toBe(false)
    expect(ref.current?.value()).toBe("review @file:README.md and @")

    // Now Enter actually sends
    act(() => t.keys.pressEnter())
    await t.settle()
    expect(sent).toEqual(["review @file:README.md and @"])
    t.destroy()
  })

  test("Enter while streaming → onEnqueue; chips render; click chip → onDequeue", async () => {
    const ref = createRef<ComposerHandle>()
    const sent: string[] = []
    const dequeued: number[] = []
    // Host owns the queue so Composer re-renders with chips as items
    // are enqueued — mirrors app.tsx wiring minus the drain effect.
    const Host = () => {
      const [q, setQ] = useState<string[]>([])
      return (
        <box flexDirection="column" flexGrow={1} width="100%" height="100%">
          <box flexGrow={1} />
          <Composer
            ref={ref} focused canSubmitPrompt={true} ready streaming queue={q} cmds={[]}
            onSend={m => sent.push(m)} onSlash={() => {}}
            onEnqueue={m => setQ(v => [...v, m])}
            onDequeue={i => { dequeued.push(i); setQ(v => v.filter((_, j) => j !== i)) }}
          />
        </box>
      )
    }
    const t: Harness = await mountNode(<Host />, { width: 120, height: 30 })
    await until(t, () => t.frame().includes("Type to queue"))

    // Input stays focused while streaming; typing + Enter enqueues.
    await act(async () => { await t.keys.typeText("follow-up one") })
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("⏸ 1. follow-up one"))
    expect(sent).toEqual([])
    expect(ref.current?.value()).toBe("")

    await act(async () => { await t.keys.typeText("two") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("⏸ 2. two"))

    // Click second chip → onDequeue(1); chip row disappears.
    const rows = t.frame().split("\n")
    const y = rows.findIndex(l => l.includes("⏸ 2."))
    await act(async () => { await t.mouse.pressDown(rows[y].indexOf("⏸"), y) })
    await until(t, () => !t.frame().includes("⏸ 2."))
    expect(dequeued).toEqual([1])
    expect(t.frame()).toContain("⏸ 1. follow-up one")
    t.destroy()
  })

  test("slash popover live while streaming; Enter accepts without enqueueing", async () => {
    const ref = createRef<ComposerHandle>()
    const slashed: SlashCommand[] = []
    const queued: string[] = []
    const sent: string[] = []
    const t: Harness = await mountNode(
      <box flexDirection="column" flexGrow={1} width="100%" height="100%">
        <box flexGrow={1} />
        <Composer
          ref={ref} focused canSubmitPrompt={true} ready streaming queue={[]} cmds={LOCAL_COMMANDS}
          onSend={m => sent.push(m)} onSlash={c => slashed.push(c)}
          onEnqueue={m => queued.push(m)}
        />
      </box>,
      { width: 120, height: 30 },
    )
    await until(t, () => t.frame().includes("Type to queue"))

    await act(async () => { await t.keys.typeText("/ste") })
    await t.settle()
    expect(ref.current?.popOpen()).toBe(true)
    // Popover renders its matched entry above the input.
    expect(t.frame().split("\n").filter(l => l.includes("steer")).length).toBeGreaterThan(1)

    act(() => t.keys.pressEnter())
    await t.settle()
    expect(slashed).toEqual([])
    expect(sent).toEqual([])
    expect(queued).toEqual([])
    expect(ref.current?.value()).toBe("/steer")
    expect(ref.current?.popOpen()).toBe(false)
    t.destroy()
  })

  test("paste: short multi-line inserts verbatim; ≥5 lines → paste.collapse placeholder", async () => {
    const { t, ref } = await setup()

    await act(async () => { await t.keys.pasteBracketedText("a\nb\nc") })
    await t.settle()
    expect(ref.current?.value()).toBe("a\nb\nc")
    expect(ref.current?.lines()).toBe(3)
    expect(t.gw.last("paste.collapse")).toBeUndefined()

    act(() => ref.current?.set(""))
    await t.settle()

    const big = Array.from({ length: 7 }, (_, i) => `line${i}`).join("\n")
    await act(async () => { await t.keys.pasteBracketedText(big) })
    await until(t, () => (ref.current?.value() ?? "").includes("[Pasted text #1"))
    expect(t.gw.last("paste.collapse")?.params.text).toBe(big)
    expect(ref.current?.value()).toContain("7 lines")
    t.destroy()
  })

  test("paste: trailing newlines stripped; CRLF normalised; bare-newline passes through", async () => {
    const { t, ref } = await setup()

    await act(async () => { await t.keys.pasteBracketedText("git status\n") })
    await t.settle()
    expect(ref.current?.value()).toBe("git status")
    expect(ref.current?.lines()).toBe(1)

    act(() => ref.current?.set(""))
    await act(async () => { await t.keys.pasteBracketedText("a\r\nb\r\n\r\n") })
    await t.settle()
    expect(ref.current?.value()).toBe("a\nb")

    act(() => ref.current?.set("x"))
    await act(async () => { await t.keys.pasteBracketedText("\n\n") })
    await t.settle()
    expect(ref.current?.value()).toBe("x\n\n")
    t.destroy()
  })
})

describe("composer: paste → file drop detection", () => {
  type Drop = import("../src/context/wire").DropDetectResponse
  async function dropSetup(respond: (text: string) => Drop) {
    const gw = new MockGateway()
    gw.on$("input.detect_drop", p => respond(String(p.text)))
    const ref = createRef<ComposerHandle>()
    const attached: Array<import("../src/context/wire").ImageAttachResponse> = []
    const t: Harness = await mountNode(
      <box flexDirection="column" flexGrow={1} width="100%" height="100%">
        <box flexGrow={1} />
        <Composer
          ref={ref}
          focused canSubmitPrompt={true} ready streaming={false} cmds={LOCAL_COMMANDS}
          attachments={attached}
          onSend={() => {}} onSlash={() => {}}
          onAttach={r => attached.push(r)}
        />
      </box>,
      { gw, width: 120, height: 30 },
    )
    await until(t, () => t.frame().includes("Ready"))
    return { t, ref, attached }
  }

  test("image path → chip via onAttach, buffer stays empty", async () => {
    const { t, ref, attached } = await dropSetup(() => ({
      matched: true, is_image: true, path: "/tmp/shot.png", count: 1,
      name: "shot.png", width: 1440, height: 900, token_estimate: 1600,
      text: "[User attached image: shot.png]",
    }))
    await act(async () => { await t.keys.pasteBracketedText("/tmp/shot.png") })
    await until(t, () => attached.length === 1)
    expect(t.gw.last("input.detect_drop")?.params.text).toBe("/tmp/shot.png")
    expect(attached[0]).toEqual({
      attached: true, path: "/tmp/shot.png", count: 1, name: "shot.png",
      width: 1440, height: 900, token_estimate: 1600,
    })
    expect(ref.current?.value()).toBe("")
    t.destroy()
  })

  test("image path + trailing prose → chip, remainder inserted", async () => {
    const { t, ref, attached } = await dropSetup(() => ({
      matched: true, is_image: true, path: "/tmp/shot.png", count: 1,
      name: "shot.png", text: "what is this?",
    }))
    await act(async () => { await t.keys.pasteBracketedText("/tmp/shot.png what is this?") })
    await until(t, () => attached.length === 1)
    expect(ref.current?.value()).toBe("what is this? ")
    t.destroy()
  })

  test("non-image file → wrapped text inserted and chip mirrored", async () => {
    const { t, ref, attached } = await dropSetup(() => ({
      matched: true, is_image: false, path: "/tmp/report.pdf", name: "report.pdf",
      text: "[User attached file: /tmp/report.pdf]",
    }))
    await act(async () => { await t.keys.pasteBracketedText("/tmp/report.pdf") })
    await until(t, () => (ref.current?.value() ?? "").length > 0)
    expect(ref.current?.value()).toBe("[User attached file: /tmp/report.pdf] ")
    expect(attached).toEqual([{ attached: true, path: "/tmp/report.pdf", name: "report.pdf" }])
    t.destroy()
  })

  test("miss → verbatim insert", async () => {
    const { t, ref, attached } = await dropSetup(() => ({ matched: false }))
    await act(async () => { await t.keys.pasteBracketedText("/not/a/real/file") })
    await until(t, () => ref.current?.value() === "/not/a/real/file")
    expect(attached).toEqual([])
    t.destroy()
  })

  test("RPC error → verbatim insert", async () => {
    const gw = new MockGateway()
    gw.on$("input.detect_drop", () => { throw new Error("boom") })
    const ref = createRef<ComposerHandle>()
    const t: Harness = await mountNode(
      <box flexDirection="column" flexGrow={1} width="100%" height="100%">
        <box flexGrow={1} />
        <Composer ref={ref} focused canSubmitPrompt={true} ready streaming={false} cmds={LOCAL_COMMANDS}
          onSend={() => {}} onSlash={() => {}} />
      </box>,
      { gw, width: 120, height: 30 },
    )
    await until(t, () => t.frame().includes("Ready"))
    await act(async () => { await t.keys.pasteBracketedText("~/oops.png") })
    await until(t, () => ref.current?.value() === "~/oops.png")
    t.destroy()
  })

  test("non-path paste never calls input.detect_drop", async () => {
    const { t, ref } = await dropSetup(() => ({ matched: false }))
    await act(async () => { await t.keys.pasteBracketedText("just words") })
    await t.settle()
    expect(ref.current?.value()).toBe("just words")
    expect(t.gw.last("input.detect_drop")).toBeUndefined()
    t.destroy()
  })
})
