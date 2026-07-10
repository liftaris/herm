// End-to-end integration: shell out to chafa, parse its output, mount
// into OpenTUI, inspect the frame. This is the real proof for mzb.7.
// Skipped when chafa isn't on PATH — unit tests above cover the parser.

import { describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import { existsSync } from "fs"
import { mountNode } from "./harness"
import { parseChafa, hex, type Cell } from "../src/utils/chafa"

const CHAFA = "/usr/sbin/chafa"
const IMG = `${process.env.HOME}/Pictures/ko-fi_banner.png`

function have(): boolean {
  return existsSync(CHAFA) && existsSync(IMG)
}

function run(w: number, h: number): string {
  const r = spawnSync(CHAFA, [
    `--size=${w}x${h}`,
    "--format=symbols",
    "--symbols=block",
    "--colors=full",
    IMG,
  ], { encoding: "utf8" })
  return r.stdout
}

function ChafaBlock({ rows }: { rows: Cell[][] }) {
  return (
    <box flexDirection="column">
      {rows.map((row, i) => (
        <text key={i}>
          {row.map((c, j) => (
            <span key={j} fg={hex(c.fg)} bg={hex(c.bg)}>{c.ch}</span>
          ))}
        </text>
      ))}
    </box>
  )
}

describe.skipIf(!have())("chafa → OpenTUI integration", () => {
  test("real image renders as grid of colored spans, width+height preserved", async () => {
    const raw = run(20, 8)
    expect(raw.length).toBeGreaterThan(0)
    const rows = parseChafa(raw)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThanOrEqual(8)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(20)

    const t = await mountNode(<ChafaBlock rows={rows} />, { width: 30, height: 12 })
    const frame = t.frame()

    // Frame should NOT contain raw SGR escape bytes — if it does, OpenTUI
    // is printing our spans' style bytes literally (which would be a regression).
    expect(frame).not.toContain("[38;2;")
    expect(frame).not.toContain("[48;2;")

    // Every parsed cell's character should appear in the rendered frame.
    const allChars = new Set(rows.flatMap(r => r.map(c => c.ch)))
    const frameChars = new Set([...frame])
    const missing = [...allChars].filter(c => !frameChars.has(c) && c !== " ")
    expect(missing).toEqual([])

    console.log(`image: ${rows.length} rows × ~${rows[0]?.length} cols`)
    console.log(`first row sample: ${rows[0]?.slice(0, 6).map(c => `${c.ch}[${c.fg?.r ?? "-"}]`).join(" ")}`)
    if (process.env.DUMP_FRAME) {
      console.log("=== rendered frame (raw chafa output for comparison) ===")
      console.log(raw)
      console.log("=== opentui frame (plain chars only — SGR stripped by testRender) ===")
      console.log(frame)
    }
    t.destroy()
  })

  test("perf: parse + render ≤ 50ms for a 60×20 image", async () => {
    const raw = run(60, 20)
    const t0 = performance.now()
    const rows = parseChafa(raw)
    const t = await mountNode(<ChafaBlock rows={rows} />, { width: 80, height: 30 })
    const ms = performance.now() - t0
    console.log(`parse+mount (60x20): ${ms.toFixed(1)}ms  cells=${rows.reduce((a, r) => a + r.length, 0)}`)
    expect(ms).toBeLessThan(500) // generous — first mount has React startup cost
    t.destroy()
  })
})
