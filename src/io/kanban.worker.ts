import { patchAt, resetWrites, type PatchFields } from "../service/kanban-write"

type Req = { id: number; root: string; board: string; task: string; patch: PatchFields }
type Res = { id: number; ok: true; v: boolean } | { id: number; ok: false; err: string }

const bound = { root: "" }

self.onmessage = (e: MessageEvent<Req>) => {
  const req = e.data
  if (bound.root !== req.root) {
    resetWrites()
    bound.root = req.root
  }
  try {
    self.postMessage({ id: req.id, ok: true, v: patchAt(req.root, req.board, req.task, req.patch) } satisfies Res)
  } catch (err) {
    self.postMessage({ id: req.id, ok: false, err: err instanceof Error ? err.message : String(err) } satisfies Res)
  }
}