import { existsSync } from "node:fs"
import { join } from "node:path"
import { kanbanRoot } from "../service/hermes-kanban"
import { patchAt, type PatchFields } from "../service/kanban-write"

type Res = { id: number; ok: true; v: boolean } | { id: number; ok: false; err: string }

const INLINE = process.env.HERM_IO_INLINE === "1"
const entry = () => {
  const js = join(import.meta.dirname, "kanban.worker.js")
  return new URL(existsSync(js) ? "./kanban.worker.js" : "./kanban.worker.ts", import.meta.url)
}

const state = {
  worker: null as Worker | null,
  seq: 0,
  pending: new Map<number, (res: Res) => void>(),
}

const spawn = () => {
  if (state.worker) return state.worker
  const worker = new Worker(entry())
  worker.onmessage = (e: MessageEvent<Res>) => {
    state.pending.get(e.data.id)?.(e.data)
    state.pending.delete(e.data.id)
  }
  worker.onerror = (e) => {
    const err = `kanban worker: ${e.message}`
    for (const resolve of state.pending.values()) resolve({ id: -1, ok: false, err })
    state.pending.clear()
    if (state.worker === worker) state.worker = null
    worker.terminate()
  }
  return (state.worker = worker)
}

export async function patch(board: string, task: string, value: PatchFields): Promise<boolean> {
  const root = kanbanRoot()
  if (INLINE) return patchAt(root, board, task, value)
  return new Promise((resolve, reject) => {
    const id = ++state.seq
    state.pending.set(id, res => res.ok ? resolve(res.v) : reject(new Error(res.err)))
    spawn().postMessage({ id, root, board, task, patch: value })
  })
}

export function close(): void {
  state.worker?.terminate()
  state.worker = null
  for (const resolve of state.pending.values()) resolve({ id: -1, ok: false, err: "kanban worker: closed" })
  state.pending.clear()
}