import { describe, expect, test } from "bun:test"
import { act } from "react"
import { mountNode, until } from "./harness"
import { DiffTabs } from "../src/components/chat/DiffTabs"
import type { ToolPart } from "../src/types/message"

const udiff = (path: string, body: string) => [
  `--- a/${path}`,
  `+++ b/${path}`,
  "@@ -1,3 +1,3 @@",
  ` keep`,
  `-old ${body}`,
  `+new ${body}`,
].join("\n")

const tool = (id: string, preview: string, body: string): ToolPart => ({
  type: "tool", id, name: "patch", args: "",
  preview, status: "done", duration: 5, diff: udiff(preview, body),
})

describe("DiffTabs", () => {
  test("renders nothing when no diff-bearing tools", async () => {
    const t = await mountNode(<DiffTabs tools={[]} />, { width: 80, height: 8 })
    await t.settle()
    const f = t.frame()
    // No left bar, no panel chrome, no @@ hunk markers.
    expect(f).not.toContain("┃")
    expect(f).not.toContain("@@")
    t.destroy()
  })

  test("single diff: tab label is basename and body is collapsed", async () => {
    const t = await mountNode(
      <DiffTabs tools={[tool("a", "src/foo.ts", "thing")]} />,
      { width: 80, height: 16 },
    )
    await until(t, () => t.frame().includes("foo.ts"))
    const f = t.frame()
    expect(f).toContain("foo.ts")
    const tabRow = f.split("\n").find(l => /foo\.ts/.test(l) && !/src\/foo\.ts/.test(l))
    expect(tabRow).toBeDefined()
    expect(f).not.toContain("+1")
    expect(f).not.toContain("-1")
    expect(f).not.toContain("+new thing")
    t.destroy()
  })

  test("clicking a tab toggles its body", async () => {
    const tools = [
      tool("a", "alpha.ts", "alpha"),
      tool("b", "beta.ts", "beta"),
      tool("c", "gamma.ts", "gamma"),
    ]
    const t = await mountNode(<DiffTabs tools={tools} />, { width: 100, height: 18 })
    await until(t, () => t.frame().includes("alpha.ts") && t.frame().includes("gamma.ts"))
    expect(t.frame()).not.toContain("+new alpha")
    expect(t.frame()).not.toContain("+new beta")

    const rows = t.frame().split("\n")
    const y = rows.findIndex(l => l.includes("beta.ts"))
    const x = rows[y].indexOf("beta.ts")
    await act(async () => { await t.mouse.pressDown(x, y) })
    await until(t, () => t.frame().includes("+new beta"))
    expect(t.frame()).not.toContain("+new alpha")

    const next = t.frame().split("\n")
    const y2 = next.findIndex(l => l.includes("beta.ts"))
    const x2 = next[y2].indexOf("beta.ts")
    await act(async () => { await t.mouse.pressDown(x2, y2) })
    await until(t, () => !t.frame().includes("+new beta"))
    t.destroy()
  })

  test("duplicate basenames disambiguated by parent dir", async () => {
    const tools = [
      tool("a", "src/chat/Foo.tsx", "chatfoo"),
      tool("b", "src/ui/Foo.tsx", "uifoo"),
    ]
    const t = await mountNode(<DiffTabs tools={tools} />, { width: 100, height: 16 })
    await until(t, () => t.frame().includes("chat/Foo.tsx"))
    expect(t.frame()).toContain("chat/Foo.tsx")
    expect(t.frame()).toContain("ui/Foo.tsx")
    t.destroy()
  })

  test("ribbon wraps to multiple rows at narrow width", async () => {
    const tools = Array.from({ length: 8 }, (_, i) =>
      tool(`t${i}`, `file${i}.ts`, `body${i}`))
    const t = await mountNode(<DiffTabs tools={tools} />, { width: 40, height: 24 })
    await until(t, () => t.frame().includes("file0.ts") && t.frame().includes("file7.ts"))
    const rows = t.frame().split("\n")
    const firstY = rows.findIndex(l => l.includes("file0.ts"))
    const lastY = rows.findIndex(l => l.includes("file7.ts"))
    // Wrap means the last tab sits below the first.
    expect(lastY).toBeGreaterThan(firstY)
    t.destroy()
  })

  test("falls back when tool has no preview path", async () => {
    const t = await mountNode(
      <DiffTabs tools={[{
        type: "tool", id: "np", name: "patch", args: "",
        status: "done", duration: 1, diff: udiff("x", "y"),
      }]} />,
      { width: 80, height: 12 },
    )
    // No args, no preview — pathFor falls back to the diff's `+++ b/x` header.
    await until(t, () => t.frame().includes("x"))
    expect(t.frame()).not.toContain("+new y")
    t.destroy()
  })

  test("strips ANSI escapes from tool.preview before using as label", async () => {
    // Some patch tools pre-color their preview path for a pty. The chat
    // surface must strip those bytes — OpenTUI <text> renders escapes as
    // literal characters and the leak is loud now that preview IS the
    // entire tab label.
    const colored = "\x1b[38;2;21;60;115m delta\x1b[0m"
    const t = await mountNode(
      <DiffTabs tools={[tool("a", colored, "x")]} />,
      { width: 80, height: 12 },
    )
    await until(t, () => t.frame().includes("delta"))
    const f = t.frame()
    expect(f).not.toMatch(/\x1b/)
    expect(f).not.toContain("38;2;21;60;115")
    expect(f).not.toContain("[0m")
    t.destroy()
  })

  test("extracts path from JSON args (gateway sends args blob in preview)", async () => {
    // tool.start.context for patch/write_file tools is the raw args JSON,
    // not a path. Without args→path extraction, base() splits the JSON tail
    // and labels read like "…@" / "…ueberry" (real bug — see screenshot).
    const argsBlob = JSON.stringify({
      path: "/tmp/diff-test/b.txt",
      old_string: "cherry",
      new_string: "CHERRY",
    })
    const t = await mountNode(
      <DiffTabs tools={[{
        type: "tool", id: "p1", name: "patch",
        args: argsBlob, preview: argsBlob,
        status: "done", duration: 5, diff: udiff("/tmp/diff-test/b.txt", "z"),
      }]} />,
      { width: 80, height: 14 },
    )
    await until(t, () => t.frame().includes("b.txt"))
    expect(t.frame()).not.toMatch(/…@|…ueberry|"path"/)
    t.destroy()
  })

  test("falls back to unified-diff +++ header when args lack a path", async () => {
    // No JSON args; the diff body's `+++ b/<path>` header is the next-best source.
    const t = await mountNode(
      <DiffTabs tools={[{
        type: "tool", id: "p2", name: "patch", args: "",
        status: "done", duration: 5, diff: udiff("src/widget.ts", "z"),
      }]} />,
      { width: 80, height: 14 },
    )
    await until(t, () => t.frame().includes("widget.ts"))
    t.destroy()
  })

  test("strips friendly verb prefix only after args and diff headers miss", async () => {
    const t = await mountNode(
      <DiffTabs tools={[{
        type: "tool", id: "p3", name: "patch", args: "",
        preview: "Editing src/fallback.ts", status: "done", duration: 5,
        diff: ["@@ -1 +1 @@", "-old", "+new"].join("\n"),
      }]} />,
      { width: 80, height: 14 },
    )
    await until(t, () => t.frame().includes("fallback.ts"))
    expect(t.frame()).not.toContain("Editing")
    t.destroy()
  })

  test("keeps args and diff header precedence over friendly preview", async () => {
    const tools: ToolPart[] = [
      {
        type: "tool", id: "args", name: "patch",
        args: JSON.stringify({ path: "src/from-args.ts" }),
        preview: "Editing src/from-preview.ts", status: "done", duration: 5,
        diff: udiff("src/from-diff.ts", "a"),
      },
      {
        type: "tool", id: "diff", name: "patch", args: "",
        preview: "Editing src/from-preview.ts", status: "done", duration: 5,
        diff: udiff("src/from-diff.ts", "b"),
      },
    ]
    const t = await mountNode(<DiffTabs tools={tools} />, { width: 100, height: 14 })
    await until(t, () => t.frame().includes("from-args.ts") && t.frame().includes("from-diff.ts"))
    expect(t.frame()).not.toContain("from-preview.ts")
    expect(t.frame()).not.toContain("Editing")
    t.destroy()
  })

  test("sanitizes gateway CLI-rendered inline_diff (┊/summary/…/arrow-header)", async () => {
    // Actual shape gateway sends: display.py's _render_inline_unified_diff
    // REPLACES `--- a/` / `+++ b/` with `a/path → b/path` (one line),
    // then `┊ review diff`, `+N/-M`, and `…` truncation can wrap it.
    const cliRendered = [
      "  ┊ review diff",
      "a//tmp/diff-test/c.txt → b//tmp/diff-test/c.txt",
      "@@ -1,4 +1,4 @@",
      "-north",
      "+NORTH",
      " southeast",
      " northeast",
      " west",
      "… more",
      "+1 / -1",
    ].join("\n")
    const t = await mountNode(
      <DiffTabs tools={[{
        type: "tool", id: "c", name: "patch", args: "",
        preview: cliRendered, status: "done", duration: 5, diff: cliRendered,
      }]} />,
      { width: 100, height: 20 },
    )
    await until(t, () => t.frame().includes("c.txt"))
    const rows = t.frame().split("\n")
    const y = rows.findIndex(l => l.includes("c.txt"))
    const x = rows[y].indexOf("c.txt")
    await act(async () => { await t.mouse.pressDown(x, y) })
    await until(t, () => t.frame().includes("+NORTH"))
    const f = t.frame()
    // Tab label is c.txt — no `→ b/` arrow leakage into label.
    expect(f).not.toContain("review diff")
    expect(f).not.toContain("┊")
    // The arrow-header line itself isn't rendered as a diff row.
    const bodyRows = f.split("\n").filter(l => /→ b/.test(l))
    expect(bodyRows.length).toBe(0)
    expect(f).toContain("-north")
    expect(f).toContain("+NORTH")
    expect(f).not.toContain("… more")
    t.destroy()
  })

  test("five parallel patches → five distinct basenames in tab strip", async () => {
    // Real bug from screenshot: five tabs all read as diff body tails
    // (`…@`, `… autumn`, `…)`) because pathFor was falling through to
    // the wrong source. With DIFF_HEAD_ARROW each tool gets its own path.
    const mk = (name: string, old: string, neu: string) => ({
      type: "tool" as const,
      id: `t-${name}`, name: "patch", args: "",
      status: "done" as const, duration: 5,
      diff: [
        "  ┊ review diff",
        `a//tmp/diff-test/${name} → b//tmp/diff-test/${name}`,
        "@@ -1,4 +1,4 @@",
        `-${old}`,
        `+${neu}`,
        " unchanged",
        "+1 / -1",
      ].join("\n"),
    })
    const tools = [
      mk("sample.txt", "line one", "LINE ONE"),
      mk("greek.txt", "alpha", "ALPHA"),
      mk("colors.txt", "red", "RED"),
      mk("c.txt", "west", "WEST"),
      mk("d.txt", "winter", "WINTER"),
    ]
    const t = await mountNode(<DiffTabs tools={tools} />, { width: 120, height: 24 })
    await until(t, () => t.frame().includes("sample.txt"))
    const f = t.frame()
    expect(f).toContain("sample.txt")
    expect(f).toContain("greek.txt")
    expect(f).toContain("colors.txt")
    expect(f).toContain("c.txt")
    expect(f).toContain("d.txt")
    expect(f).not.toMatch(/…@|… autumn|…\)/)
    t.destroy()
  })
})
