import { testRender } from "@opentui/react/test-utils"
import { strict as assert } from "node:assert"
import { cpus, loadavg } from "node:os"
import { act, useState } from "react"

let update: (tick: number) => void

function Tree({ rows }: { rows: number }) {
  const [tick, set] = useState(0)
  update = set
  return (
    <box flexDirection="column" width="100%" height="100%">
      <box height={1}><text>{`tick ${tick}`}</text></box>
      <scrollbox scrollY flexGrow={1} flexBasis={0}>
        <box flexDirection="column" width="100%">
          {Array.from({ length: rows }, (_, i) => (
            <box key={i} height={1} flexDirection="row">
              <box width={8}><text>{`#${i}`}</text></box>
              <box flexGrow={1} minWidth={0}>
                <text fg="#88aaff">{`row ${i} lorem ipsum dolor sit amet ${i % 7 === 0 ? tick : ""}`}</text>
              </box>
              <box width={10}><text>{`${(i * 37) % 1000}`}</text></box>
            </box>
          ))}
        </box>
      </scrollbox>
    </box>
  )
}

const rounds = 3
const frames = 100
const warmup = 20
const opentui = await Bun.file(new URL("../node_modules/@opentui/core/package.json", import.meta.url)).json()
console.log(JSON.stringify({ bun: Bun.version, opentui: opentui.version, width: 160, height: 48, rounds, frames, warmup, cpus: cpus().length, load: loadavg() }))

for (const rows of [200, 2000]) {
  const samples = { update: [] as number[], idle: [] as number[] }
  for (let round = 0; round < rounds; round++) {
    const t = await testRender(<Tree rows={rows} />, { width: 160, height: 48 })
    await t.renderOnce()
    try {
      for (let tick = 0; tick < warmup + frames; tick++) {
        const start = performance.now()
        act(() => update(tick))
        await t.renderOnce()
        const elapsed = performance.now() - start
        if (tick >= warmup) samples.update.push(elapsed)
      }
      assert.ok(t.captureCharFrame().includes(`tick ${warmup + frames - 1}`))
      assert.ok(t.captureCharFrame().includes(`row 0 lorem ipsum dolor sit amet ${warmup + frames - 1}`))
      for (let i = 0; i < frames; i++) {
        const start = performance.now()
        await t.renderOnce()
        samples.idle.push(performance.now() - start)
      }
      assert.ok(t.captureCharFrame().includes(`tick ${warmup + frames - 1}`))
    } finally {
      act(() => t.renderer.destroy())
    }
  }
  for (const [scenario, values] of Object.entries(samples)) {
    values.sort((a, b) => a - b)
    console.log(JSON.stringify({ rows, scenario, samples: values.length, median: values[Math.ceil(values.length * 0.5) - 1], p95: values[Math.ceil(values.length * 0.95) - 1], min: values[0], max: values.at(-1), unit: "ms/frame", verified: true }))
  }
}
