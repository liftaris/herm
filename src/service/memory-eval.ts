import { summarizeShadow, summaryText } from "./memory-shadow"
import { recallPacket, type Adapter, type Intent, type Packet, type Policy, type Result as Hit, type Source } from "./memory-router"

export type Fixture = {
  id: string
  category: string
  prompt: string
  expectIntent?: Intent
  expectSkipped?: boolean
  expectDegraded?: boolean
  expectSourcePrefix?: string[]
  minInjects?: number
  mustQuery?: string[]
  forbidQuery?: string[]
  mustInject?: string[]
}

export type Result = {
  id: string
  category: string
  query: string
  skipped: boolean
  passed: boolean
  errors: string[]
  intent?: Intent
  injects: number
  degraded: number
  sources: string[]
  packet?: Packet
}

export type Report = {
  total: number
  passed: number
  failed: string[]
  results: Result[]
  summary: ReturnType<typeof summarizeShadow>
}

export type Opts = Policy & {
  adapters: Adapter[]
  shadowPath?: false
}

const refs = /<memory-context>[\s\S]*?<\/memory-context>/gi
const words = (text: string): string[] => text.match(/[A-Za-z0-9_]{2,}/g) ?? []
const clean = (text: string): string => text.replace(/^MEDIA:.+$/gm, "").trim()
const query = (text: string): string => clean(text.replace(refs, "").replace(/\n{3,}/g, "\n\n"))
const should = (text: string): boolean => {
  const q = query(text)
  if (!q || q.startsWith("/") || q.startsWith("!")) return false
  return q.length >= 18 || words(q).length >= 4
}
const degraded = (text: string): number => Array.from(text.matchAll(/<memory-context>([\s\S]*?)<\/memory-context>/gi))
  .flatMap(x => x[1].split("\n"))
  .filter(x => {
    const s = x.trim()
    return /[:：]$/.test(s) || /[.…]$/.test(s) || /\b(garbled|truncated|cut off|incomplete)\b/i.test(s)
  }).length

const missing = (hay: string, needles: string[]): string[] => needles.filter(x => !hay.includes(x))
const present = (hay: string, needles: string[]): string[] => needles.filter(x => hay.includes(x))

const src = {
  semantic: { kind: "semantic", name: "agentmemory", read: true, write: true },
  repo: { kind: "repo", name: "repo", read: true, write: false },
  vault: { kind: "vault", name: "obsidian", read: true, write: false },
} satisfies Record<string, Source>

const hit = (id: string, source: Source, content: string, confidence = 0.92): Hit => ({
  id,
  source,
  title: id,
  content,
  confidence,
})

const set = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? [])

export function fixtureAdapters(): Adapter[] {
  return [
    {
      ...src.semantic,
      search: q => {
        const want = set(q.text)
        return [
          hit("arch", src.semantic, "Hermes router stays baseline and agentmemory remains the only semantic writer."),
          hit("closeout", src.semantic, "Cody closeouts update memory and skills only on signal."),
          hit("riley", src.semantic, "Paperclip owns Rally ops while Hermes owns routing and memory authority."),
          hit("imessage", src.semantic, "For iMessage simple lookups use the fastest reliable path and reply in one finished bubble."),
          hit("life", src.semantic, "Agent tool evaluations must include lifestyle capabilities like dinner reservations and travel."),
          hit("truncated", src.semantic, "Price flags ~5 minute iMessage response times:", 0.62),
        ].filter(x => Array.from(set(`${x.title} ${x.content}`)).some(w => want.has(w)))
      },
    },
    {
      ...src.repo,
      search: q => q.text.includes("config") ? [hit("repo-config", src.repo, "Obsidian is authority; repo config is current truth for memory settings.")] : [],
    },
    {
      ...src.vault,
      search: q => q.text.includes("config") ? [hit("vault-config", src.vault, "Obsidian is authority over semantic hints.")] : [],
    },
  ]
}

export function reportText(report: Report): string {
  const rows = report.results.map(x => `${x.passed ? "PASS" : "FAIL"} ${x.id} [${x.category}] injects=${x.injects} degraded=${x.degraded}${x.errors.length ? ` errors=${x.errors.join("; ")}` : ""}`)
  return [
    `Memory eval: ${report.passed}/${report.total} passed`,
    report.failed.length ? `failed: ${report.failed.join(" | ")}` : "failed: none",
    "",
    ...rows,
    "",
    summaryText(report.summary),
  ].join("\n")
}

export async function evaluateMemoryFixtures(fixtures: Fixture[], opts: Opts): Promise<Report> {
  const rows: string[] = []
  const results = await Promise.all(fixtures.map(async fix => {
    const q = query(fix.prompt)
    const skip = !should(fix.prompt)
    const errors: string[] = []
    const ref = degraded(fix.prompt)
    if (fix.expectSkipped !== undefined && fix.expectSkipped !== skip) errors.push(`expected skipped=${fix.expectSkipped}`)
    if (missing(q, fix.mustQuery ?? []).length) errors.push(`query missing ${missing(q, fix.mustQuery ?? []).join(", ")}`)
    if (present(q, fix.forbidQuery ?? []).length) errors.push(`query included ${present(q, fix.forbidQuery ?? []).join(", ")}`)
    if (skip) {
      rows.push(JSON.stringify({ query: q, baseline: { injects: 0, results: 0, degraded: ref, sourceMs: {} }, candidates: [] }))
      return {
        id: fix.id,
        category: fix.category,
        query: q,
        skipped: true,
        passed: errors.length === 0,
        errors,
        injects: 0,
        degraded: ref,
        sources: [],
      }
    }
    const packet = await recallPacket(opts.adapters, { text: q }, opts)
    const context = packet.context
    const total = ref + packet.results.filter(x => x.degraded).length
    if (fix.expectIntent && packet.trace.intent !== fix.expectIntent) errors.push(`intent ${packet.trace.intent} !== ${fix.expectIntent}`)
    if (fix.minInjects !== undefined && packet.injects.length < fix.minInjects) errors.push(`injects ${packet.injects.length} < ${fix.minInjects}`)
    if (fix.expectDegraded && total === 0) errors.push("expected degraded context")
    if (missing(context, fix.mustInject ?? []).length) errors.push(`context missing ${missing(context, fix.mustInject ?? []).join(", ")}`)
    const sources = packet.results.map(x => x.source.name)
    if (fix.expectSourcePrefix && fix.expectSourcePrefix.some((x, i) => sources[i] !== x)) errors.push(`source prefix ${sources.slice(0, fix.expectSourcePrefix.length).join(",")} !== ${fix.expectSourcePrefix.join(",")}`)
    rows.push(JSON.stringify({
      query: q,
      baseline: {
        injects: packet.injects.length,
        results: packet.results.length,
        degraded: total,
        sourceMs: packet.trace.sourceMs,
      },
      candidates: [],
    }))
    return {
      id: fix.id,
      category: fix.category,
      query: q,
      skipped: false,
      passed: errors.length === 0,
      errors,
      intent: packet.trace.intent,
      injects: packet.injects.length,
      degraded: total,
      sources,
      packet,
    }
  }))
  const failed = results.filter(x => !x.passed).map(x => `${x.id}: ${x.errors.join("; ")}`)
  return {
    total: fixtures.length,
    passed: results.length - failed.length,
    failed,
    results,
    summary: summarizeShadow(rows.join("\n")),
  }
}

export * as memoryEval from "./memory-eval"
