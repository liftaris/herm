import { describe, expect, test } from "bun:test"
import { act } from "react"
import { mountNode, until } from "./harness"
import { splitContent, classify, MEDIA_LINE_RE } from "../src/components/chat/MediaChip"
import { previewStrategy } from "../src/utils/terminal-image"
import { MessageItem } from "../src/components/chat/MessageItem"
import type { Message } from "../src/types/message"

describe("MediaChip > splitContent", () => {
  test("no-media fast path returns input verbatim", () => {
    const s = splitContent("plain text\nno directives")
    expect(s).toEqual([{ md: "plain text\nno directives" }])
  })

  test("splits on MEDIA lines, preserving order and adjacency", () => {
    const s = splitContent("before\nMEDIA:/tmp/a.png\nafter")
    expect(s).toEqual([
      { md: "before" },
      { media: "/tmp/a.png" },
      { md: "after" },
    ])
  })

  test("adjacent MEDIA lines and quoted/backticked paths", () => {
    const s = splitContent("`MEDIA: /tmp/a.png`\n\"MEDIA:/tmp/b.mp3\"")
    expect(s).toEqual([
      { media: "/tmp/a.png" },
      { media: "/tmp/b.mp3" },
    ])
  })

  test("MEDIA inside fenced code is literal, not a directive", () => {
    const text = "```sh\nMEDIA:/tmp/x.png\n```\nMEDIA:/tmp/y.png"
    const s = splitContent(text)
    expect(s).toEqual([
      { code: "MEDIA:/tmp/x.png", lang: "sh" },
      { media: "/tmp/y.png" },
    ])
  })

  test("extracts remote markdown images as chip media", () => {
    expect(splitContent("see ![alt](https://x.test/a.png) now")).toEqual([
      { md: "see " },
      { media: "https://x.test/a.png" },
      { md: " now" },
    ])
  })

  test("MEDIA mid-line is not a directive", () => {
    expect("see MEDIA:/tmp/x.png here".match(MEDIA_LINE_RE)).toBeNull()
    expect(splitContent("see MEDIA:/tmp/x.png here")).toEqual([
      { md: "see MEDIA:/tmp/x.png here" },
    ])
  })
})

describe("splitContent > fences", () => {
  test("extracts fenced block with lang, prose either side", () => {
    const s = splitContent("before\n```ts\nconst x = 1\n```\nafter")
    expect(s).toEqual([
      { md: "before" },
      { code: "const x = 1", lang: "ts" },
      { md: "after" },
    ])
  })

  test("no lang → undefined; ~~~ fences; 4-backtick outer nests 3-backtick inner", () => {
    expect(splitContent("~~~\nraw\n~~~")).toEqual([{ code: "raw", lang: undefined }])
    const s = splitContent("````md\n```ts\ninner\n```\n````")
    expect(s).toEqual([{ code: "```ts\ninner\n```", lang: "md" }])
  })

  test("unclosed fence stays as markdown (streaming tail)", () => {
    const s = splitContent("intro\n```ts\npartial")
    expect(s).toEqual([{ md: "intro\n```ts\npartial" }])
  })

  test("adjacent fence + media with blank separators", () => {
    const s = splitContent("```py\nprint(1)\n```\n\nMEDIA:/a.png")
    expect(s).toEqual([
      { code: "print(1)", lang: "py" },
      { md: "" },
      { media: "/a.png" },
    ])
  })
})

describe("MediaChip > classify", () => {
  test("extension → kind", () => {
    expect(classify("/tmp/a.png")).toBe("img")
    expect(classify("/tmp/a.JPG")).toBe("img")
    expect(classify("/tmp/a.mp3")).toBe("audio")
    expect(classify("/tmp/a.mp4")).toBe("video")
    expect(classify("/tmp/a.pdf")).toBe("file")
    expect(classify("https://x.co/a.png")).toBe("url")
  })
})

describe("MessageItem > media rendering", () => {
  test("transcript images use the shared preview strategy", () => {
    expect(previewStrategy({ path: "/tmp/screenshot.png", exists: true, chafa: false })).toEqual({
      kind: "chip",
      reason: "no-renderer",
    })
  })

  const msg = (content: string): Message => ({
    id: "a1", role: "assistant", timestamp: 0, model: "test",
    parts: [{ type: "text", content, streaming: false }],
  })

  test("renders MEDIA: as badge chip, not literal text", async () => {
    const t = await mountNode(
      <box flexDirection="column" width="100%" height="100%">
        <MessageItem message={msg("result:\nMEDIA:/tmp/screenshot.png\ndone.")} streaming={false} />
      </box>,
      { width: 100, height: 20 },
    )
    await until(t, () => t.frame().includes("result:") && t.frame().includes("done."))
    const f = t.frame()
    expect(f).toContain(" img ")
    expect(f).toContain("screenshot.png")
    // Directive itself not rendered as literal
    expect(f).not.toContain("MEDIA:/tmp")
    t.destroy()
  })

  test("renders fenced code with chrome — lang label, line count, click-to-copy", async () => {
    const t = await mountNode(
      <box flexDirection="column" width="100%" height="100%">
        <MessageItem
          message={msg("here:\n```ts\nconst x = 1\nconst y = 2\n```\ndone.")}
          streaming={false}
        />
      </box>,
      { width: 100, height: 20 },
    )
    await until(t, () => t.frame().includes("here:") && t.frame().includes("done."))
    const f = t.frame()
    // ┃-bar panel, lang label, body, line count
    expect(f).toContain("┃")
    const hdr = f.split("\n").find(l => l.includes("┃") && l.includes("ts"))!
    expect(hdr).toMatch(/ts\s.*2 ln/)
    expect(f).toContain("const x = 1")
    expect(f).not.toContain("```")

    // hover header → 'copy' appears; click → toast
    const lines = f.split("\n")
    const y = lines.findIndex(l => /┃.*\bts\b.*2 ln/.test(l))
    const x = lines[y].indexOf("2 ln")
    await act(async () => { await t.mouse.moveTo(x, y) })
    await until(t, () => t.frame().includes("⧉ copy"))
    await act(async () => { await t.mouse.pressDown(x, y) })
    await until(t, () => t.frame().includes("Copied 2 lines"))
    t.destroy()
  })
})
