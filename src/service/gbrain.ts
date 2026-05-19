import type { Adapter, Query, Result } from "./memory-router"

export type Req = {
  cmd: string[]
  env: Record<string, string>
  cwd?: string
  timeout: number
}

export type Opts = {
  bin?: string
  cmd?: string[]
  home?: string
  cwd?: string
  timeoutMs?: number
  run?: (req: Req) => Promise<string>
}

type Row = {
  slug?: unknown
  title?: unknown
  chunk_text?: unknown
  compiled_truth?: unknown
  score?: unknown
  stale?: unknown
  source_id?: unknown
  effective_date?: unknown
}

const src = { kind: "semantic" as const, name: "gbrain", read: true, write: false }
const text = (x: unknown): string => typeof x === "string" ? x : ""
const num = (x: unknown): number => typeof x === "number" && Number.isFinite(x) ? x : 0
const clamp = (x: number): number => Math.max(0.78, Math.min(0.94, 0.78 + x * 0.3))

const spawn = async (req: Req): Promise<string> => {
  const proc = Bun.spawn(req.cmd, {
    cwd: req.cwd,
    env: { ...process.env, ...req.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const kill = setTimeout(() => proc.kill(), req.timeout)
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(kill)
  if (code !== 0) throw new Error(err.trim() || `gbrain exited ${code}`)
  return out
}

const rows = (out: string): Row[] => {
  const got = JSON.parse(out) as unknown
  return Array.isArray(got) ? got as Row[] : []
}

export function gbrainAdapter(opts: Opts = {}): Adapter {
  return {
    ...src,
    search: async (query: Query, limit = 5): Promise<Result[]> => {
      const cmd = [...(opts.cmd ?? [opts.bin ?? process.env.HERMES_GBRAIN_BIN ?? "gbrain"]), "call", "search", JSON.stringify({ query: query.text, limit })]
      const out = await (opts.run ?? spawn)({
        cmd,
        cwd: opts.cwd ?? process.env.HERMES_GBRAIN_CWD,
        env: opts.home ? { GBRAIN_HOME: opts.home } : {},
        timeout: opts.timeoutMs ?? 1200,
      })
      return rows(out).map((row, i) => {
        const slug = text(row.slug) || `result-${i}`
        const content = text(row.chunk_text) || text(row.compiled_truth)
        return {
          id: `gbrain:${slug}:${i}`,
          source: src,
          title: text(row.title) || slug,
          content,
          confidence: clamp(num(row.score)),
          stale: row.stale === true,
          file: slug,
          updatedAt: Date.parse(text(row.effective_date)) || undefined,
        }
      }).filter(r => r.content)
    },
  }
}

export * as gbrain from "./gbrain"
