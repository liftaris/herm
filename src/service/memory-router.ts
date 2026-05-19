export type MemoryKind = "hot" | "session" | "semantic" | "vault" | "repo" | "local" | "skill"
export type Intent = "preference" | "history" | "pattern" | "truth" | "procedure" | "local" | "source"

export type Source = {
  kind: MemoryKind
  name: string
  read: boolean
  write: boolean
}

export type Result = {
  id: string
  source: Source
  title: string
  content: string
  confidence: number
  stale?: boolean
  deprecated?: boolean
  degraded?: boolean
  file?: string
  url?: string
  sessionId?: string
  createdAt?: number
  updatedAt?: number
}

export type Query = {
  text: string
  intent?: Intent
}

export type Inject = {
  result: Result
  reason: string
}

export type DropReason = "timeout" | "error" | "duplicate" | "low_confidence" | "stale" | "deprecated" | "degraded" | "over_budget"

export type Trace = {
  intent: Intent
  queried: string[]
  sourceMs: Record<string, number>
  dropped: Array<{ id?: string; source: string; reason: DropReason }>
}

export type Policy = {
  limit?: number
  perSourceLimit?: number
  timeoutMs?: number
  minConfidence?: number
  charBudget?: number
}

export type Packet = {
  query: Query
  results: Result[]
  injects: Inject[]
  context: string
  trace: Trace
}

const ORDER: Record<Intent, MemoryKind[]> = {
  preference: ["hot", "vault", "session", "semantic"],
  history: ["session", "semantic", "vault"],
  pattern: ["semantic", "session", "skill", "vault"],
  truth: ["repo", "vault", "hot", "session", "semantic"],
  procedure: ["skill", "vault", "semantic", "session"],
  local: ["local", "semantic", "session", "vault"],
  source: ["vault", "repo", "session", "semantic"],
}

const has = (q: string, words: string[]) => words.some(w => q.includes(w))
const strip = (s: string): string => s.replace(/>{2,3}|<{2,3}/g, "").trim()
const terms = (s: string): string[] => s.toLowerCase().match(/[a-z0-9_]+/g)?.filter(w => w.length > 1) ?? []
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim()

export function intentOf(text: string): Intent {
  const q = text.toLowerCase()
  if (has(q, ["prefer", "preference", "likes", "hates", "call me", "timezone"])) return "preference"
  if (has(q, ["last time", "yesterday", "earlier", "previous", "what did we do", "history"])) return "history"
  if (has(q, ["source", "article", "clipping", "bookmark", "vault note", "obsidian note"])) return "source"
  if (has(q, ["how do we", "procedure", "workflow", "playbook", "skill", "steps"])) return "procedure"
  if (has(q, ["current", "true now", "config", "setting", "repo", "file", "actual"])) return "truth"
  if (has(q, ["this profile", "this project", "local recall", "scoped", "mnemosyne"])) return "local"
  return "pattern"
}

export function orderOf(intent: Intent): MemoryKind[] {
  return ORDER[intent]
}

export function rank(sources: Source[], query: Query): Source[] {
  const intent = query.intent ?? intentOf(query.text)
  const order = orderOf(intent)
  return sources
    .filter(s => s.read && order.includes(s.kind))
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name))
}

export function canWrite(source: Source, owner: string): boolean {
  return source.write && source.name === owner
}

export function canInject(result: Result, min = 0.7): boolean {
  return result.confidence >= min && result.stale !== true && result.deprecated !== true && result.degraded !== true
}

export function explain(result: Result): string {
  const flags = [
    result.stale ? "stale" : "",
    result.deprecated ? "deprecated" : "",
    result.degraded ? "degraded" : "",
  ].filter(Boolean).join(", ")
  const via = result.file ?? result.url ?? result.sessionId ?? result.id
  return `${result.source.name}/${result.source.kind} · ${via} · confidence ${result.confidence}${flags ? ` · ${flags}` : ""}`
}

export function inject(results: Result[], min = 0.7): Inject[] {
  return results.filter(r => canInject(r, min)).map(result => ({ result, reason: explain(result) }))
}

export type Adapter = Source & {
  search: (query: Query, limit?: number) => Result[] | Promise<Result[]>
}

export type SessionHit = {
  session_id: string
  snippet: string
  role: string
  source: string
  model: string | null
  started_at: number
  title: string | null
}

export type VaultDoc = {
  file: string
  content: string
  title?: string
  createdAt?: number
  updatedAt?: number
}

const score = (doc: VaultDoc, query: Query): number => {
  const words = terms(query.text)
  if (words.length === 0) return 0
  const hay = `${doc.title ?? ""} ${doc.file} ${doc.content}`.toLowerCase()
  const hits = words.filter(w => hay.includes(w)).length
  return hits / words.length
}

const degraded = (s: string): boolean => {
  const text = strip(s)
  if (!text) return false
  if (/[:：]$/.test(text)) return true
  if (/[.…]$/.test(text)) return true
  return /\b(garbled|truncated|cut off|incomplete)\b/i.test(text)
}

export function fromSessions(
  search: (query: string, limit?: number) => SessionHit[],
  source: Source = { kind: "session", name: "session_search", read: true, write: false },
): Adapter {
  return {
    ...source,
    write: false,
    search: (query, limit = 5) => search(query.text, limit).map(hit => {
      const content = strip(hit.snippet)
      return {
        id: `${source.name}:${hit.session_id}`,
        source: { ...source, write: false },
        title: hit.title ?? hit.session_id,
        content,
        confidence: degraded(content) ? 0.62 : 0.82,
        degraded: degraded(content),
        sessionId: hit.session_id,
        createdAt: hit.started_at,
      }
    }),
  }
}

export function fromVault(
  docs: VaultDoc[],
  source: Source = { kind: "vault", name: "obsidian", read: true, write: false },
): Adapter {
  return {
    ...source,
    write: false,
    search: (query, limit = 5) => docs
      .map(doc => ({ doc, score: score(doc, query) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.doc.updatedAt ?? 0) - (a.doc.updatedAt ?? 0))
      .slice(0, limit)
      .map(x => ({
        id: `${source.name}:${x.doc.file}`,
        source: { ...source, write: false },
        title: x.doc.title ?? x.doc.file,
        content: x.doc.content,
        confidence: Math.min(0.95, 0.55 + x.score * 0.4),
        file: x.doc.file,
        createdAt: x.doc.createdAt,
        updatedAt: x.doc.updatedAt,
      })),
  }
}

const key = (result: Result): string => {
  if (result.file) return `file:${result.file}`
  if (result.url) return `url:${result.url}`
  if (result.sessionId) return `session:${result.sessionId}:${norm(`${result.title} ${result.content.slice(0, 120)}`)}`
  return `text:${norm(`${result.title} ${result.content.slice(0, 160)}`) || `${result.source.name}:${result.id}`}`
}

const better = (a: Result, b: Result, order: MemoryKind[]): Result => {
  const ai = order.indexOf(a.source.kind)
  const bi = order.indexOf(b.source.kind)
  if (ai !== bi) return ai < bi ? a : b
  if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a : b
  return (a.updatedAt ?? a.createdAt ?? 0) >= (b.updatedAt ?? b.createdAt ?? 0) ? a : b
}

const run = async (source: Adapter, query: Query, limit: number, timeout: number) => {
  const start = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeouted = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), timeout) })
  try {
    const got = await Promise.race([Promise.resolve(source.search(query, limit)), timeouted])
    if (timer) clearTimeout(timer)
    if (got === "timeout") return { source, results: [], ms: Date.now() - start, timeout: true }
    return { source, results: got, ms: Date.now() - start }
  } catch (err) {
    if (timer) clearTimeout(timer)
    return { source, results: [], ms: Date.now() - start, error: err }
  }
}

export function formatMemoryContext(injects: Inject[], budget = 2400): string {
  if (injects.length === 0) return ""
  return injects.reduce((text, item) => {
    const line = `- [${item.reason}] ${item.result.content.replace(/\s+/g, " ").trim()}`
    const next = text ? `${text}\n${line}` : `Relevant memory:\n${line}`
    return next.length <= budget ? next : text
  }, "")
}

export async function recallPacket(sources: Adapter[], query: Query, policy: Policy = {}): Promise<Packet> {
  const intent = query.intent ?? intentOf(query.text)
  const ordered = rank(sources, { ...query, intent }) as Adapter[]
  const trace: Trace = { intent, queried: ordered.map(s => s.name), sourceMs: {}, dropped: [] }
  const batches = await Promise.all(ordered.map(s => run(s, { ...query, intent }, policy.perSourceLimit ?? policy.limit ?? 8, policy.timeoutMs ?? 1200)))
  batches.forEach(x => {
    trace.sourceMs[x.source.name] = x.ms
    if (x.timeout) trace.dropped.push({ source: x.source.name, reason: "timeout" })
    if (x.error) trace.dropped.push({ source: x.source.name, reason: "error" })
  })
  const order = orderOf(intent)
  const map = new Map<string, Result>()
  batches.flatMap(x => x.results).forEach(result => {
    const k = key(result)
    const old = map.get(k)
    if (old) trace.dropped.push({ id: result.id, source: result.source.name, reason: "duplicate" })
    map.set(k, old ? better(old, result, order) : result)
  })
  const results = Array.from(map.values())
    .sort((a, b) => order.indexOf(a.source.kind) - order.indexOf(b.source.kind) || b.confidence - a.confidence)
    .slice(0, policy.limit ?? 8)
  results.forEach(result => {
    if (result.confidence < (policy.minConfidence ?? 0.7)) trace.dropped.push({ id: result.id, source: result.source.name, reason: "low_confidence" })
    if (result.stale) trace.dropped.push({ id: result.id, source: result.source.name, reason: "stale" })
    if (result.deprecated) trace.dropped.push({ id: result.id, source: result.source.name, reason: "deprecated" })
    if (result.degraded) trace.dropped.push({ id: result.id, source: result.source.name, reason: "degraded" })
  })
  const injects = inject(results, policy.minConfidence ?? 0.7)
  const context = formatMemoryContext(injects, policy.charBudget)
  if (injects.length > 0 && !context) trace.dropped.push(...injects.map(x => ({ id: x.result.id, source: x.result.source.name, reason: "over_budget" as const })))
  return { query: { ...query, intent }, results, injects, context, trace }
}

export async function recall(sources: Adapter[], query: Query, limit = 8): Promise<Result[]> {
  return (await recallPacket(sources, query, { limit })).results
}

export * as memoryRouter from "./memory-router"
