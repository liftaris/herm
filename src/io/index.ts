// Off-thread state.db access.
//
// `io.<fn>(...)` has the same signature as the underlying sync reader
// but returns a Promise and executes inside one long-lived Worker. The
// worker owns its own readonly sqlite handle; structured-clone carries
// plain row objects back.
//
// Why this exists: bun:sqlite is synchronous. `roots(2000)` on a 438 MB
// state.db is ~1 s wall — run on the main thread it freezes the render
// loop between tab-switch keypress and first paint. Inside the worker
// the main loop stays >93 % responsive during the same call (probe:
// 1,427 of 1,524 ms a 1 ms ticker kept firing).
//
// Frame semantics: a worker `message` event is a macrotask that Bun
// schedules *after* `process.nextTick`. OpenTUI's request-driven
// `requestRender` path is `nextTick → activateFrame`, so any `setState`
// issued before `await io.x()` has committed to a frame by the time the
// await resolves — no `renderer.idle()` choreography needed.
//
// Tests set HERM_IO_INLINE=1 (preload.ts): `io.*` then calls the sync
// fn directly on the main thread so fixtures/sandbox paths resolve and
// no worker process is spawned per test file.

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Fns, Fn } from "./fns"

type Res = { id: number; ok: true; v: unknown } | { id: number; ok: false; err: string }
type IO = { readonly [K in Fn]: (...a: Parameters<Fns[K]>) => Promise<ReturnType<Fns[K]>> }

const INLINE = process.env.HERM_IO_INLINE === "1"
const HOME = () => process.env.HERMES_HOME || join(homedir(), ".hermes")

// Bundled build emits db.worker.js next to index.js; dev runs the .ts
// source. Same probe-then-fallback opentui uses for parser.worker.
const entry = () => {
  const js = join(import.meta.dirname, "db.worker.js")
  return new URL(existsSync(js) ? "./db.worker.js" : "./db.worker.ts", import.meta.url)
}

const state = {
  w: null as Worker | null,
  seq: 0,
  pending: new Map<number, (r: Res) => void>(),
  inline: null as Promise<Fns> | null,
}

const spawn = (): Worker => {
  if (state.w) return state.w
  const w = new Worker(entry())
  w.onmessage = (e: MessageEvent<Res>) => {
    const r = e.data
    state.pending.get(r.id)?.(r)
    state.pending.delete(r.id)
  }
  w.onerror = (ev) => {
    const err = `io worker: ${ev.message}`
    for (const res of state.pending.values()) res({ id: -1, ok: false, err })
    state.pending.clear()
    if (state.w === w) state.w = null
    w.terminate()
  }
  return (state.w = w)
}

const call = <K extends Fn>(fn: K, args: Parameters<Fns[K]>): Promise<ReturnType<Fns[K]>> => {
  if (INLINE) {
    state.inline ??= import("./fns").then(m => m.FNS)
    return state.inline.then(f => (f[fn] as (...a: unknown[]) => ReturnType<Fns[K]>)(...args))
  }
  return new Promise((resolve, reject) => {
    const id = ++state.seq
    state.pending.set(id, r => r.ok
      ? resolve(r.v as ReturnType<Fns[K]>)
      : reject(new Error(r.err)))
    spawn().postMessage({ id, home: HOME(), fn, args })
  })
}

/** `io.roots(2000)`, `io.analytics(7)`, … — async mirrors of FNS. */
export const io = new Proxy({} as IO, {
  get: (_, fn) => (...args: unknown[]) => call(fn as Fn, args as never),
}) as IO

/** Boot the worker before it's needed so the first real call doesn't
 *  eat the ~30 ms spawn+parse on top of its query. No-op inline. */
export const warm = () => { if (!INLINE) void call("roots", [0]) }

/** Tests / hot-reload: drop the worker and reject anything in flight. */
export const close = () => {
  state.w?.terminate()
  state.w = null
  for (const res of state.pending.values()) res({ id: -1, ok: false, err: "io: closed" })
  state.pending.clear()
}
