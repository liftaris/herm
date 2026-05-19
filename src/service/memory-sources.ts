import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative } from "node:path"
import { search as find } from "./sessions-db"
import { hermesPath } from "./hermes-home"
import { explain, formatMemoryContext, fromSessions, fromVault, recall, recallPacket, type Adapter, type Query, type Result, type Source, type VaultDoc } from "./memory-router"

const SKIP = new Set([".git", ".obsidian", "node_modules", "dist", "build", ".next", "coverage", "data"])
const EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".yaml", ".yml", ".toml"])
const HOME = process.env.HOME || homedir()
const VAULT = process.env.OBSIDIAN_VAULT_PATH || process.env.OBSIDIAN_VAULT || `${HOME}/obsidian-vault`
const AM = process.env.AGENTMEMORY_URL || "http://127.0.0.1:3111"
const BOOT = [
  "context/cody/current-state.md",
  "context/cody/cody-current-context.md",
  "now/price-now.md",
]

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>
export type AmOpts = { url?: string; secret?: string; fetch?: Fetch; timeoutMs?: number }
type AmHit = {
  obsId?: unknown
  sessionId?: unknown
  title?: unknown
  narrative?: unknown
  text?: unknown
  score?: unknown
  timestamp?: unknown
}

const title = (content: string, file: string): string =>
  content.match(/^#\s+(.+)$/m)?.[1]?.trim() || file

const ext = (file: string): string => file.match(/\.[^.]+$/)?.[0] ?? ""
const today = () => new Date().toISOString().slice(0, 10)

const uniq = (files: string[]): string[] => {
  const seen = new Set<string>()
  return files.filter(file => {
    if (seen.has(file)) return false
    seen.add(file)
    return true
  })
}

const walk = (dir: string, all = false): string[] => {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(ent => {
    const file = join(dir, ent.name)
    if (ent.isDirectory() && !SKIP.has(ent.name)) return walk(file, all)
    if (ent.isFile() && (all ? EXT.has(ext(ent.name)) : ent.name.endsWith(".md"))) return [file]
    return []
  })
}

const time = (raw: unknown): number | undefined => {
  if (typeof raw === "number") return raw
  if (typeof raw !== "string") return undefined
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : undefined
}

const content = (hit: AmHit): string => {
  if (typeof hit.narrative === "string") return hit.narrative
  if (typeof hit.text === "string") return hit.text
  return ""
}

const readFiles = (root: string, files: string[]): VaultDoc[] =>
  files.flatMap(file => {
    try {
      const stat = statSync(file)
      if (stat.size > 200_000) return []
      const text = readFileSync(file, "utf8")
      const rel = relative(root, file) || file
      return [{
        file: rel,
        title: title(text, rel),
        content: text,
        createdAt: stat.birthtimeMs,
        updatedAt: stat.mtimeMs,
      }]
    } catch {
      return []
    }
  })

export function readDocs(root: string, max = 500, all = false): VaultDoc[] {
  return readFiles(root, walk(root, all).slice(0, max))
}

export function readVault(root = VAULT, max = 500): VaultDoc[] {
  const boot = [...BOOT, `daily/${today()}.md`].map(file => join(root, file))
  return readFiles(root, uniq([...boot, ...walk(root)]).slice(0, max))
}

export function sessionAdapter(): Adapter {
  return fromSessions(find)
}

const cached = (root: string, source: Source, max = 500, all = false): Adapter => {
  let docs: VaultDoc[] | null = null
  let loaded = 0
  const ttl = 10_000
  return {
    ...fromVault([], source),
    search: (query, limit) => {
      if (!docs || Date.now() - loaded > ttl) {
        docs = source.kind === "vault" ? readVault(root, max) : readDocs(root, max, all)
        loaded = Date.now()
      }
      return fromVault(docs, source).search(query, limit)
    },
  }
}

export function vaultAdapter(root = VAULT): Adapter {
  return cached(root, { kind: "vault", name: "obsidian", read: true, write: false })
}

export function hotAdapter(root = hermesPath("memories")): Adapter {
  return cached(root, { kind: "hot", name: "hermes_profile", read: true, write: false }, 10)
}

export function repoAdapter(root = process.cwd()): Adapter {
  return cached(root, { kind: "repo", name: "repo", read: true, write: false }, 400, true)
}

export function agentmemoryAdapter(opts: AmOpts = {}): Adapter {
  const src = { kind: "semantic" as const, name: "agentmemory", read: true, write: false }
  const url = (opts.url ?? AM).replace(/\/$/, "")
  const ask = opts.fetch ?? fetch
  return {
    ...src,
    search: async (query, limit = 5) => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 1200)
      try {
        const res = await ask(`${url}/agentmemory/search`, {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            "content-type": "application/json",
            ...(opts.secret ?? process.env.AGENTMEMORY_SECRET
              ? { authorization: `Bearer ${opts.secret ?? process.env.AGENTMEMORY_SECRET}` }
              : {}),
          },
          body: JSON.stringify({ query: query.text, limit, format: "narrative", token_budget: 1200 }),
        })
        clearTimeout(timer)
        if (!res.ok) return []
        const json = await res.json() as { results?: AmHit[] }
        return (Array.isArray(json.results) ? json.results : []).flatMap(hit => {
          const id = typeof hit.obsId === "string" ? hit.obsId : ""
          const text = content(hit)
          if (!id || !text) return []
          const score = typeof hit.score === "number" ? Math.max(0, Math.min(hit.score, 1)) : 0.5
          return [{
            id: `agentmemory:${id}`,
            source: src,
            title: typeof hit.title === "string" ? hit.title : id,
            content: text,
            confidence: Math.min(0.95, 0.65 + score * 0.3),
            sessionId: typeof hit.sessionId === "string" ? hit.sessionId : undefined,
            createdAt: time(hit.timestamp),
          }]
        })
      } catch {
        clearTimeout(timer)
        return []
      }
    },
  }
}

export type LocalOpts = {
  hot?: boolean | string
  repo?: boolean | string
  vault?: string | false
  sessions?: boolean
  agentmemory?: boolean | AmOpts
  limit?: number
  timeoutMs?: number
  charBudget?: number
}

export function sources(opts: LocalOpts = {}): Adapter[] {
  return [
    opts.hot === false ? null : hotAdapter(typeof opts.hot === "string" ? opts.hot : undefined),
    opts.repo === false ? null : repoAdapter(typeof opts.repo === "string" ? opts.repo : undefined),
    opts.agentmemory === false ? null : agentmemoryAdapter(typeof opts.agentmemory === "object" ? opts.agentmemory : {}),
    opts.sessions === false ? null : sessionAdapter(),
    opts.vault === false ? null : vaultAdapter(opts.vault),
  ].filter((x): x is Adapter => x !== null)
}

export async function localRecall(query: Query, opts: LocalOpts = {}): Promise<Result[]> {
  return recall(sources(opts), query, opts.limit)
}

export async function formatRecall(text: string, opts: LocalOpts = {}): Promise<string> {
  const query = text.trim()
  if (!query) return "usage: /recall <query>"
  const packet = await recallPacket(sources(opts), { text: query }, { limit: opts.limit, timeoutMs: opts.timeoutMs, charBudget: opts.charBudget })
  if (packet.results.length === 0) return `No recall hits for “${query}”.`
  return packet.results.map((item, i) => [
    `${i + 1}. ${item.title}`,
    `   ${explain(item)}`,
    `   ${item.content.replace(/\s+/g, " ").slice(0, 260)}`,
  ].join("\n")).join("\n\n")
}

export async function formatRecallContext(text: string, opts: LocalOpts = {}): Promise<string> {
  const query = text.trim()
  if (!query) return "usage: /recall use <query>"
  const packet = await recallPacket(sources(opts), { text: query }, { limit: opts.limit, timeoutMs: opts.timeoutMs, charBudget: opts.charBudget })
  if (!packet.context) return `No injectable recall hits for “${query}”.`
  return formatMemoryContext(packet.injects, opts.charBudget ?? 2400)
}

export async function formatRecallTrace(text: string, opts: LocalOpts = {}): Promise<string> {
  const query = text.trim()
  if (!query) return "usage: /recall trace <query>"
  const packet = await recallPacket(sources(opts), { text: query }, { limit: opts.limit, timeoutMs: opts.timeoutMs, charBudget: opts.charBudget })
  const drops = packet.trace.dropped.length === 0
    ? "drops: none"
    : `drops:\n${packet.trace.dropped.map(x => `- ${x.source}${x.id ? `/${x.id}` : ""}: ${x.reason}`).join("\n")}`
  return [
    `intent: ${packet.trace.intent}`,
    `queried: ${packet.trace.queried.join(", ")}`,
    `latency: ${Object.entries(packet.trace.sourceMs).map(([k, v]) => `${k}=${v}ms`).join(", ")}`,
    `injectable: ${packet.injects.length}/${packet.results.length}`,
    drops,
  ].join("\n")
}

export * as memorySources from "./memory-sources"
