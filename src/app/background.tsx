// In-flight /background task ids. Registered on prompt.background,
// unregistered on background.complete.

import { createContext, useCallback, useMemo, useState, type ReactNode } from "react"
import { makeUse } from "../context/helper"

type Ctx = {
  count: number
  ids: readonly string[]
  register: (id: string, title?: string) => void
  unregister: (id: string) => void
  label: (id: string) => string | undefined
}

const ctx = createContext<Ctx | null>(null)

export const BackgroundProvider = ({ children }: { children: ReactNode }) => {
  const [jobs, setJobs] = useState<ReadonlyMap<string, string>>(() => new Map())
  const register = useCallback((id: string, title = "") => {
    if (!id) return
    setJobs(prev => {
      if (prev.get(id) === title) return prev
      const next = new Map(prev)
      next.set(id, title)
      return next
    })
  }, [])
  const unregister = useCallback((id: string) => {
    setJobs(prev => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])
  const label = useCallback((id: string) => jobs.get(id)?.trim() || undefined, [jobs])
  const ids = useMemo(() => Array.from(jobs.keys()), [jobs])
  const value = useMemo<Ctx>(
    () => ({ count: ids.length, ids, register, unregister, label }),
    [ids, register, unregister, label],
  )
  return <ctx.Provider value={value}>{children}</ctx.Provider>
}

export const useBackground = makeUse(ctx, "useBackground")
