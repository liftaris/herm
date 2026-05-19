import { candidate as get } from "./memory-candidates"
import type { Adapter, MemoryKind, Result } from "./memory-router"
import type { Candidate as Shadow } from "./memory-context"

type Env = Record<string, string | undefined>

type Hit = {
  id?: string
  slug?: string
  title?: string
  content?: string
  text?: string
  chunk_text?: string
  score?: number
  confidence?: number
}

type Req = {
  url: string
  query: { query: string; limit: number }
}

type Opts = {
  env?: Env
}

type Endpoint = {
  name: string
  url: string
  kind?: MemoryKind
  call?: (req: Req) => Promise<Hit[]> | Hit[]
}

const ext = ["hindsight", "mem0", "graphiti-zep", "cognee", "supermemory"]

const key = (name: string): string | undefined => get(name)?.env?.[0]
const kind = (name: string): MemoryKind => name === "graphiti-zep" ? "semantic" : "semantic"
const conf = (hit: Hit): number => Math.max(0.1, Math.min(0.95, hit.confidence ?? (hit.score ? 0.55 + hit.score * 0.4 : 0.72)))
const body = (hit: Hit): string => hit.content ?? hit.text ?? hit.chunk_text ?? ""

export function endpointAdapter(opts: Endpoint): Adapter {
  const source = { kind: opts.kind ?? kind(opts.name), name: opts.name, read: true, write: false }
  return {
    ...source,
    search: async (query, limit = 5) => {
      const req = { url: opts.url, query: { query: query.text, limit } }
      const hits = opts.call ? await opts.call(req) : await fetch(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req.query),
      }).then(r => r.json() as Promise<Hit[]>)
      return hits.map((hit, i): Result => ({
        id: `${opts.name}:${hit.id ?? hit.slug ?? i}`,
        source,
        title: hit.title ?? `${opts.name} result`,
        content: body(hit),
        confidence: conf(hit),
      })).filter(x => x.content)
    },
  }
}

export function candidateAdapters(opts: Opts = {}): Shadow[] {
  return ext.map(name => {
    const env = key(name)
    const url = env ? opts.env?.[env] ?? process.env[env] : undefined
    if (!url) return { name, adapters: [], error: "config-missing" }
    return { name, adapters: [endpointAdapter({ name, url })] }
  })
}

export * as adapters from "./memory-candidate-adapters"
