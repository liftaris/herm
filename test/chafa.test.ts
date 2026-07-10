import { describe, expect, test } from "bun:test"
import { parseChafaLine, parseChafa, hex } from "../src/utils/chafa"
import { previewStrategy } from "../src/utils/terminal-image"

const ESC = "\x1b"

describe("image preview strategy", () => {
  test("chafa wins when image exists and chafa is available", () => {
    expect(previewStrategy({ path: "/tmp/a.png", exists: true, chafa: true })).toEqual({
      kind: "chafa",
      reason: "chafa-supported",
    })
  })

  test("chip is the final fallback without chafa", () => {
    expect(previewStrategy({ path: "/tmp/a.png", exists: true, chafa: false })).toEqual({
      kind: "chip",
      reason: "no-renderer",
    })
  })

  test("missing and unsupported images use chip", () => {
    expect(previewStrategy({ path: "/tmp/missing.png", exists: false, chafa: true })).toEqual({
      kind: "chip",
      reason: "missing",
    })
    expect(previewStrategy({ path: "/tmp/not-image.txt", exists: true, chafa: true })).toEqual({
      kind: "chip",
      reason: "unsupported",
    })
  })

  test("remote urls stay chips even when the extension looks image-like", () => {
    expect(previewStrategy({ path: "https://x.test/a.png", exists: true, chafa: true })).toEqual({
      kind: "chip",
      reason: "remote",
    })
  })
})

describe("chafa parser", () => {
  test("empty line → no cells", () => {
    expect(parseChafaLine("")).toEqual([])
  })

  test("plain ASCII → cells with null fg/bg", () => {
    expect(parseChafaLine("Hi")).toEqual([
      { ch: "H", fg: null, bg: null },
      { ch: "i", fg: null, bg: null },
    ])
  })

  test("24-bit fg applies forward until reset", () => {
    const line = `${ESC}[38;2;255;0;0mAB${ESC}[0mC`
    const cells = parseChafaLine(line)
    expect(cells).toHaveLength(3)
    expect(cells[0]).toEqual({ ch: "A", fg: { r: 255, g: 0, b: 0 }, bg: null })
    expect(cells[1]).toEqual({ ch: "B", fg: { r: 255, g: 0, b: 0 }, bg: null })
    expect(cells[2]).toEqual({ ch: "C", fg: null, bg: null })
  })

  test("combined fg+bg in one SGR", () => {
    const line = `${ESC}[38;2;10;20;30;48;2;40;50;60mX`
    const [c] = parseChafaLine(line)
    expect(c.fg).toEqual({ r: 10, g: 20, b: 30 })
    expect(c.bg).toEqual({ r: 40, g: 50, b: 60 })
  })

  test("reverse video swaps fg/bg for following cells until reset", () => {
    const line = `${ESC}[38;2;255;0;0m${ESC}[48;2;0;0;255m${ESC}[7mX${ESC}[0mY`
    const cells = parseChafaLine(line)
    expect(cells[0]).toEqual({ ch: "X", fg: { r: 0, g: 0, b: 255 }, bg: { r: 255, g: 0, b: 0 } })
    expect(cells[1]).toEqual({ ch: "Y", fg: null, bg: null })
  })

  test("unicode half-block characters preserved", () => {
    const line = `${ESC}[38;2;255;0;0m▀▄█`
    const cells = parseChafaLine(line)
    expect(cells.map(c => c.ch)).toEqual(["▀", "▄", "█"])
  })

  test("unterminated SGR at end of line is ignored, not an infinite loop", () => {
    const line = `X${ESC}[38`
    const cells = parseChafaLine(line)
    expect(cells).toEqual([{ ch: "X", fg: null, bg: null }])
  })

  test("multi-line → row array preserving row count", () => {
    const text = `${ESC}[38;2;1;2;3mA\n${ESC}[38;2;4;5;6mB\nC`
    const rows = parseChafa(text)
    expect(rows).toHaveLength(3)
    expect(rows[0][0].fg).toEqual({ r: 1, g: 2, b: 3 })
    expect(rows[1][0].fg).toEqual({ r: 4, g: 5, b: 6 })
    expect(rows[2][0].fg).toBeNull()
  })

  test("hex() formats 24-bit RGB", () => {
    expect(hex({ r: 255, g: 0, b: 128 })).toBe("#ff0080")
    expect(hex({ r: 0, g: 0, b: 0 })).toBe("#000000")
    expect(hex(null)).toBeUndefined()
  })
})
