import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { act } from "react"
import { ChafaImage } from "../src/ui/ChafaImage"
import type { Rendered } from "../src/utils/chafa"
import { mountNode, until } from "./harness"

const IMG = `${process.env.HOME}/Pictures/ko-fi_banner.png`

describe("ChafaImage fallback", () => {
  test("nonexistent path → MediaChip badge, no error chrome in frame", async () => {
    const t = await mountNode(
      <ChafaImage path="/tmp/definitely-does-not-exist-xyz.png" width={40} />,
      { width: 80, height: 10 },
    )
    const f = t.frame()
    expect(f).toContain("img")
    expect(f).toContain("definitely-does-not-exist-xyz.png")
    expect(f).not.toContain("not found")
    expect(f).not.toContain("chafa")
    expect(f).not.toContain("exit")
    t.destroy()
  })

  test.skipIf(!existsSync(IMG))("real image → grid of unicode blocks + footer line", async () => {
    const t = await mountNode(
      <ChafaImage path={IMG} width={40} />,
      { width: 80, height: 20 },
    )
    await until(t, () => /[▀▄█▌▐░▒▓]/.test(t.frame()))
    const f = t.frame()
    expect(f).toContain("ko-fi_banner.png")
    expect(f).toContain("collapse")
    expect(/[▀▄█▌▐░▒▓]/.test(f)).toBe(true)
    t.destroy()
  })
})

test("ChafaImage paints a chip before asynchronous conversion completes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herm-chafa-image-"))
  const path = join(dir, "preview.png")
  await Bun.write(path, "fixture")
  let release!: (value: Rendered) => void
  const gate = new Promise<Rendered>(resolve => { release = resolve })
  const load = () => gate

  const t = await mountNode(<ChafaImage path={path} chafa load={load} bare />)
  expect(t.frame()).toContain("preview.png")
  expect(t.frame()).not.toContain("X")

  await act(async () => { release({ rows: [[{ ch: "X", fg: null, bg: null }]] }); await gate })
  await until(t, () => t.frame().includes("X"))
  expect(t.frame()).not.toContain("preview.png")
  t.destroy()
  rmSync(dir, { recursive: true, force: true })
})

test("late ChafaImage completion is ignored after unmount", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herm-chafa-image-unmount-"))
  const path = join(dir, "preview.png")
  await Bun.write(path, "fixture")
  let release!: (value: Rendered) => void
  const gate = new Promise<Rendered>(resolve => { release = resolve })
  const t = await mountNode(<ChafaImage path={path} chafa load={() => gate} bare />)

  t.destroy()
  release({ rows: [[{ ch: "X", fg: null, bg: null }]] })
  await gate
  rmSync(dir, { recursive: true, force: true })
})
