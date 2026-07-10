import { useEffect, useRef, useState } from "react"
import { io } from "../io"
import { cache, type Analytics, type NameRow } from "../service/hermes-analytics"

export type AnalyticsQuery = (days: number, opts?: { tools?: boolean }) => Promise<Analytics>

const query: AnalyticsQuery = (days, opts) => Promise.resolve(io.analytics(days, opts))

export function useAnalyticsData(days: number, tick: number, load: AnalyticsQuery = query) {
  const [data, setData] = useState<Analytics | null>(() => cache.get(days) ?? null)
  const [tools, setTools] = useState<NameRow[] | null>(() => cache.get(days)?.byTool ?? null)
  const [error, setError] = useState("")
  const gen = useRef(0)

  useEffect(() => {
    const hit = cache.get(days)
    setData(hit ?? null)
    setTools(hit?.byTool ?? null)
    setError("")
    const current = ++gen.current
    void load(days, { tools: false }).then(fast => {
      if (gen.current !== current) return
      setData(fast)
      return load(days).then(full => {
        if (gen.current !== current) return
        cache.set(days, full)
        setData(full)
        setTools(full.byTool)
      })
    }).catch(err => {
      if (gen.current === current)
        setError(err instanceof Error ? err.message : String(err))
    })
    return () => { gen.current++ }
  }, [days, tick, load])

  return { data, tools, error }
}
