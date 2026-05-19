type Metrics = {
  injects?: unknown
  results?: unknown
  sourceMs?: unknown
  degraded?: unknown
}

type Meta = Metrics & {
  name?: unknown
  lane?: unknown
  status?: unknown
  available?: unknown
  error?: unknown
}

type Cand = Metrics & {
  name?: unknown
  candidate?: unknown
}

type Row = {
  baseline?: Metrics
  candidates?: unknown
}

const num = (x: unknown): number => typeof x === "number" && Number.isFinite(x) ? x : 0
const arr = (x: unknown): Cand[] => Array.isArray(x) ? x as Cand[] : []
const sum = (x: unknown): number => typeof x === "object" && x !== null
  ? Object.values(x as Record<string, unknown>).reduce<number>((n, v) => n + num(v), 0)
  : 0
const avg = (total: number, count: number): number => count ? Math.round(total / count) : 0
const pad = (x: string | number, n: number): string => String(x).padEnd(n, " ")

const parse = (line: string): Row | undefined => {
  try {
    const got = JSON.parse(line) as unknown
    return typeof got === "object" && got !== null ? got as Row : undefined
  } catch {
    return undefined
  }
}

const meta = (c: Cand): Meta => {
  if (typeof c.candidate === "object" && c.candidate !== null) return c.candidate as Meta
  return c as Meta
}

export function summarizeShadow(text: string) {
  const rows = text.split("\n").map(x => parse(x)).filter((x): x is Row => x !== undefined)
  const base = rows.reduce((a, row) => {
    const ms = sum(row.baseline?.sourceMs)
    return {
      injects: a.injects + num(row.baseline?.injects),
      results: a.results + num(row.baseline?.results),
      degraded: a.degraded + num(row.baseline?.degraded),
      ms: a.ms + ms,
      timed: a.timed + (ms ? 1 : 0),
    }
  }, { injects: 0, results: 0, degraded: 0, ms: 0, timed: 0 })
  const map = new Map<string, {
    name: string
    runs: number
    wins: number
    misses: number
    noise: number
    degraded: number
    unavailable: number
    injects: number
    results: number
    ms: number
    timed: number
  }>()
  rows.forEach(row => arr(row.candidates).forEach(c => {
    const item = meta(c)
    const name = typeof item.name === "string" ? item.name : "candidate"
    const got = map.get(name) ?? { name, runs: 0, wins: 0, misses: 0, noise: 0, degraded: 0, unavailable: 0, injects: 0, results: 0, ms: 0, timed: 0 }
    const bin = num(row.baseline?.injects)
    const cin = num(item.injects)
    const ms = sum(item.sourceMs)
    got.runs += 1
    got.wins += bin === 0 && cin > 0 ? 1 : 0
    got.misses += bin > 0 && cin === 0 ? 1 : 0
    got.noise += bin > 0 && cin > bin ? 1 : 0
    got.degraded += num(item.degraded)
    got.unavailable += item.available === false ? 1 : 0
    got.injects += cin
    got.results += num(item.results)
    got.ms += ms
    got.timed += ms ? 1 : 0
    map.set(name, got)
  }))
  return {
    runs: rows.length,
    baseline: { injects: base.injects, results: base.results, avgMs: avg(base.ms, base.timed), degraded: base.degraded },
    candidates: Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name)).map(c => ({
      name: c.name,
      runs: c.runs,
      wins: c.wins,
      misses: c.misses,
      noise: c.noise,
      degraded: c.degraded,
      unavailable: c.unavailable,
      injects: c.injects,
      results: c.results,
      avgMs: avg(c.ms, c.timed),
    })),
  }
}

export function summaryText(report: ReturnType<typeof summarizeShadow>): string {
  const head = [
    "Memory shadow summary",
    `runs: ${report.runs}`,
    `baseline injects/results/degraded/avgMs: ${report.baseline.injects}/${report.baseline.results}/${report.baseline.degraded}/${report.baseline.avgMs}`,
  ]
  if (report.candidates.length === 0) return head.join("\n")
  return [
    ...head,
    "",
    "candidate       runs  wins  misses  noise  degraded  unavailable  injects  results  avgMs",
    ...report.candidates.map(c => [
      pad(c.name, 15),
      pad(c.runs, 6),
      pad(c.wins, 6),
      pad(c.misses, 8),
      pad(c.noise, 7),
      pad(c.degraded, 10),
      pad(c.unavailable, 13),
      pad(c.injects, 9),
      pad(c.results, 9),
      String(c.avgMs),
    ].join("")),
  ].join("\n")
}

export * as shadow from "./memory-shadow"
