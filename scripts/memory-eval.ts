#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { evaluateMemoryFixtures, fixtureAdapters, reportText, type Fixture } from "../src/service/memory-eval"
import { summarizeShadow, summaryText } from "../src/service/memory-shadow"

async function main() {
  const mode = process.argv[2] ?? "fixtures"
  const file = process.argv[3]

  if (mode === "fixtures") {
    const path = file ?? "test/fixtures/memory-eval-prompts.json"
    const cases = JSON.parse(readFileSync(path, "utf8")) as Fixture[]
    const report = await evaluateMemoryFixtures(cases, { adapters: fixtureAdapters(), shadowPath: false })
    console.log(reportText(report))
    process.exit(report.failed.length ? 1 : 0)
  }

  if (mode === "shadow") {
    const path = file ?? join(process.env.HERMES_HOME ?? join(homedir(), ".hermes"), "logs/memory-shadow.jsonl")
    const text = existsSync(path) ? readFileSync(path, "utf8") : ""
    console.log(summaryText(summarizeShadow(text)))
    process.exit(0)
  }

  console.error("usage: bun scripts/memory-eval.ts [fixtures [fixture.json] | shadow [memory-shadow.jsonl]]")
  process.exit(2)
}

void main()
