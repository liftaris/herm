#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs"
import { findRoot, generate, schemaTarget, write } from "./schema-source"

const arg = (name: string) => {
  const pos = Bun.argv.indexOf(name)
  return pos >= 0 ? Bun.argv[pos + 1] : undefined
}

const out = arg("--out")
if (Bun.argv.includes("--out") && !out) {
  console.error("gen-schema: --out requires a path")
  process.exit(2)
}

try {
  const gen = generate(findRoot())
  const target = schemaTarget(out)
  if (Bun.argv.includes("--check")) {
    if (existsSync(target) && readFileSync(target, "utf8") === gen.body) {
      console.error(`gen-schema: ${target} is current (${gen.keys.length} keys)`)
      process.exit(0)
    }
    console.error(`gen-schema: ${target} is stale`)
    process.exit(1)
  }
  write(target, gen.body)
  console.error(`gen-schema: wrote ${target} (${gen.keys.length} keys) from ${gen.root}`)
} catch (e) {
  console.error("gen-schema:", e instanceof Error ? e.message : String(e))
  process.exit(1)
}
