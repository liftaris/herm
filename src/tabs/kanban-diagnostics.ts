import { useCallback, useEffect, useRef, useState } from "react"
import type { Gateway } from "../context/gateway"
import { parseDiagnostics, q, sortDiags, type Board, type Diag } from "../service/hermes-kanban"

type Sh = { stdout: string; stderr: string; code: number }
type State = { busy: boolean; pending: Board[] | null; gen: number }

const index = (rows: ReturnType<typeof parseDiagnostics>) => {
  const out = new Map<string, Diag[]>()
  for (const row of rows)
    if (row.diagnostics.length) out.set(row.task_id, sortDiags(row.diagnostics))
  return out
}

export function useKanbanDiagnostics(gw: Gateway) {
  const [data, setData] = useState<Map<string, Map<string, Diag[]>>>(() => new Map())
  const state = useRef<State>({ busy: false, pending: null, gen: 0 })

  const refresh = useCallback(async (next: Board[]) => {
    const run = state.current
    run.gen++
    if (run.busy) { run.pending = next; return }
    run.busy = true
    let boards: Board[] | null = next
    while (boards) {
      const current = boards
      const gen = run.gen
      run.pending = null
      const pairs = await Promise.all(current.map(async board => {
        const rows = await gw.request<Sh>("shell.exec", {
          command: `hermes kanban --board ${q(board.slug)} diagnostics --json`,
        }).then(res => res.code === 0 ? index(parseDiagnostics(res.stdout)) : null)
          .catch(() => null)
        return [board.slug, rows] as const
      }))
      if (run.gen === gen) {
        setData(prev => {
          const active = new Set(current.map(board => board.slug))
          const out = new Map([...prev].filter(([slug]) => active.has(slug)))
          for (const [slug, rows] of pairs) if (rows) out.set(slug, rows)
          return out
        })
      }
      boards = run.pending
    }
    run.busy = false
  }, [gw])

  useEffect(() => () => {
    state.current.gen++
    state.current.pending = null
  }, [])

  return { data, refresh }
}
