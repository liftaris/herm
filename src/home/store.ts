/**
 * Reactive data layer for ~/.hermes/.
 *
 * A slice is a typed reader with optional dependency keys and optional
 * fs.watch paths. `ensure(k)` lazily resolves deps, reads, and starts a
 * watcher on first pull. `invalidate(k)` drops the value, re-reads if there
 * are subscribers, and cascades to dependents.
 *
 * Slices registered below; remaining readers migrate in from
 * utils/hermes-home.ts as they're converted to collectors.
 */

import { watch, existsSync, statSync, type FSWatcher } from "node:fs"
import { dirname, basename } from "node:path"
import {
  hermesPath,
  readConfig,
  readMemoryFile,
  readMemoryProviders,
  readEnvFile,
  readSoul,
  readLiveSessions,
  readToolsFromLatestSession,
  readSkillUsage,
  readCuratorState,
  makeSource,
  type HermesConfig,
  type MemoryFileInfo,
  type MemoryProviderInfo,
  type SoulInfo,
  type LiveSession,
  type SystemPromptInfo,
  type ToolsInfo,
  type SessionRow,
  type SkillUsage,
  type CuratorState,
} from "../service/hermes-home"
import type { MemoryActivity } from "../service/memory-activity"
import { count as tokenCount } from "../utils/tokens"
import { io } from "../io"

export interface HomeState {
  config: HermesConfig | null
  memory: MemoryFileInfo | null
  userProfile: MemoryFileInfo | null
  memoryProviders: MemoryProviderInfo[]
  memoryActivity: MemoryActivity[]
  env: Record<string, string>
  soul: SoulInfo | null
  liveSessions: Record<string, LiveSession>
  recentSessions: SessionRow[]
  systemPrompt: SystemPromptInfo | null
  toolsInfo: ToolsInfo | null
  skillUsage: Record<string, SkillUsage>
  curatorState: CuratorState | null
}

export type SliceKey = keyof HomeState

export interface Slice<K extends SliceKey> {
  /** Produce the value. Receives already-resolved dependency values. */
  read: (deps: Partial<HomeState>) => Promise<HomeState[K]>
  /** Slice keys this reader needs resolved first. Invalidation cascades along these edges. */
  deps?: readonly SliceKey[]
  /** Absolute paths to fs.watch. Thunk so profile-switch rebinds —
   *  paths are resolved at startWatch time, not module-load. */
  watch?: () => readonly string[]
}

type Slices = { [K in SliceKey]: Slice<K> }

const SLICES: Slices = {
  config: {
    read: () => readConfig(),
    watch: () => [hermesPath("config.yaml")],
  },
  memory: {
    read: (d) => readMemoryFile("MEMORY.md", d.config?.memory?.memory_char_limit ?? 2200),
    deps: ["config"],
    watch: () => [hermesPath("memories/MEMORY.md")],
  },
  userProfile: {
    read: (d) => readMemoryFile("USER.md", d.config?.memory?.user_char_limit ?? 1375),
    deps: ["config"],
    watch: () => [hermesPath("memories/USER.md")],
  },
  memoryProviders: {
    read: (d) => readMemoryProviders(d.config?.memory?.provider ?? ""),
    deps: ["config"],
  },
  memoryActivity: {
    read: () => io.memoryActivity(),
  },
  env: {
    read: () => readEnvFile(),
    watch: () => [hermesPath(".env")],
  },
  soul: {
    read: () => readSoul(),
    watch: () => [hermesPath("SOUL.md")],
  },
  liveSessions: {
    // Optional legacy/debug file. state.db is the persisted session source;
    // current runtime facts come from gateway session.info.
    read: () => readLiveSessions(),
    watch: () => [hermesPath("sessions/sessions.json")],
  },
  // DB-backed slices are pull-only: WAL mode means writes land in
  // state.db-wal, so watching state.db misses them until checkpoint;
  // and the query is heavy enough that firing on every checkpoint from
  // an always-mounted Sidebar is wasteful. Consumers invalidate on
  // demand (section-open, `r`, post-mutation).
  recentSessions: {
    read: () => io.roots(30),
  },
  systemPrompt: {
    // Older state.db schemas lack the column — degrade to "unknown"
    // (old readSystemPromptInfo did the same via blanket try/catch).
    read: () => io.systemPrompt().then(r => r && {
      source: makeSource("state.db"),
      sessionId: r.id,
      text: r.text,
      totalChars: r.text.length,
      tokenEstimate: tokenCount(r.text),
    }).catch(() => null),
  },
  toolsInfo: {
    // Optional legacy/debug snapshot fallback. Context prefers live
    // gateway session.info; this only preserves older profiles that still
    // emit session_*.json tool schemas.
    read: () => readToolsFromLatestSession(),
    watch: () => [hermesPath("sessions")],
  },
  skillUsage: {
    read: () => readSkillUsage(),
    watch: () => [hermesPath("skills/.usage.json")],
  },
  curatorState: {
    read: () => readCuratorState(),
    watch: () => [hermesPath("skills/.curator_state")],
  },
}

/** Reverse dep edges: key → slices that listed it in `deps`. */
const DEPENDENTS: ReadonlyMap<SliceKey, readonly SliceKey[]> = (() => {
  const m = new Map<SliceKey, SliceKey[]>()
  for (const [k, s] of Object.entries(SLICES) as [SliceKey, Slice<SliceKey>][]) {
    for (const d of s.deps ?? []) {
      const arr = m.get(d) ?? []
      arr.push(k)
      m.set(d, arr)
    }
  }
  return m
})()

const DEBOUNCE_MS = 50

export class HomeStore {
  private data: Partial<HomeState> = {}
  private subs = new Map<SliceKey, Set<() => void>>()
  private inflight = new Map<SliceKey, Promise<unknown>>()
  private watchers = new Map<SliceKey, FSWatcher[]>()
  private debounce = new Map<SliceKey, ReturnType<typeof setTimeout>>()
  private rev = new Map<SliceKey, number>()
  private gen = 0

  /** Current value, or undefined if not yet loaded. Stable ref until changed. */
  get<K extends SliceKey>(k: K): HomeState[K] | undefined {
    return this.data[k] as HomeState[K] | undefined
  }

  /** Register a change listener. Returns unsubscribe. */
  subscribe<K extends SliceKey>(k: K, cb: () => void): () => void {
    let set = this.subs.get(k)
    if (!set) this.subs.set(k, (set = new Set()))
    set.add(cb)
    return () => set.delete(cb)
  }

  /**
   * Resolve deps, read, store, start watching (first call only), notify.
   * Concurrent calls for the same key share one inflight promise.
   */
  ensure<K extends SliceKey>(k: K): Promise<HomeState[K]> {
    if (k in this.data) return Promise.resolve(this.data[k] as HomeState[K])
    const hit = this.inflight.get(k)
    if (hit) return hit as Promise<HomeState[K]>

    const slice = SLICES[k]
    const gen = this.gen
    const rev = this.rev.get(k) ?? 0
    const p = (async () => {
      const deps: Partial<HomeState> = {}
      for (const d of slice.deps ?? []) {
        (deps as Record<SliceKey, unknown>)[d] = await this.ensure(d)
      }
      const v = await slice.read(deps)
      if (gen !== this.gen || rev !== (this.rev.get(k) ?? 0)) return v
      this.data[k] = v
      this.startWatch(k, slice.watch)
      this.notify(k)
      return v
    })()

    this.inflight.set(k, p)
    const clear = () => { if (this.inflight.get(k) === p) this.inflight.delete(k) }
    void p.then(clear, clear)
    return p
  }

  /**
   * Drop the cached value; re-read if there are subscribers. Cascades to
   * dependents. Call after TUI-driven writes so the UI reflects the change
   * without waiting on a watch event.
   */
  invalidate(k: SliceKey): void {
    if (!(k in this.data) && !this.inflight.has(k)) return
    this.rev.set(k, (this.rev.get(k) ?? 0) + 1)
    delete this.data[k]
    this.inflight.delete(k)
    if (this.subs.get(k)?.size) void this.ensure(k)
    for (const dep of DEPENDENTS.get(k) ?? []) this.invalidate(dep)
  }

  update<K extends SliceKey>(k: K, fn: (v: HomeState[K]) => HomeState[K]): void {
    if (!(k in this.data)) return
    this.data[k] = fn(this.data[k] as HomeState[K])
    this.notify(k)
    for (const dep of DEPENDENTS.get(k) ?? []) this.invalidate(dep)
  }

  /** Dispose all watchers and timers. Tests must call this. */
  close(): void {
    this.gen++
    for (const ws of this.watchers.values()) for (const w of ws) w.close()
    for (const t of this.debounce.values()) clearTimeout(t)
    this.watchers.clear()
    this.debounce.clear()
    this.subs.clear()
    this.inflight.clear()
    this.rev.clear()
    this.data = {}
  }

  /** Drop all cached data and rearm watchers against the current
   *  hermesPath(). Subscribers survive — every slice with listeners is
   *  re-ensured, so mounted tabs repaint with the new profile's data. */
  reset(): void {
    this.gen++
    for (const ws of this.watchers.values()) for (const w of ws) w.close()
    for (const t of this.debounce.values()) clearTimeout(t)
    this.watchers.clear()
    this.debounce.clear()
    this.inflight.clear()
    this.rev.clear()
    this.data = {}
    for (const k of this.subs.keys())
      if (this.subs.get(k)?.size) void this.ensure(k)
  }

  private notify(k: SliceKey): void {
    const set = this.subs.get(k)
    if (set) for (const cb of set) cb()
  }

  private startWatch(k: SliceKey, watchFn: Slice<SliceKey>["watch"]): void {
    if (!watchFn || this.watchers.has(k)) return
    const paths = watchFn()
    const ws: FSWatcher[] = []
    const fire = () => {
      const prev = this.debounce.get(k)
      if (prev) clearTimeout(prev)
      this.debounce.set(k, setTimeout(() => this.invalidate(k), DEBOUNCE_MS))
    }
    for (const p of paths) {
      // Watching a file by path is unreliable across rewrites on Linux
      // (inotify binds to the inode). Watch the parent dir and filter on
      // basename so rename-into-place editors still fire. Only watch the
      // path itself when it's an existing directory.
      //
      // Known runtime gap: Bun's fs.watch(dir) never emits for entries
      // created after the watcher was armed (Node does). A target that
      // didn't exist at first ensure stays non-reactive for the process
      // lifetime. In practice only an optional file absent at launch is
      // affected; in-TUI writes call invalidate() which re-reads directly,
      // and `r` forces a manual refresh for the rare external-edit case.
      let dir = dirname(p)
      let name: string | null = basename(p)
      try {
        if (existsSync(p) && statSync(p).isDirectory()) {
          dir = p
          name = null
        }
      } catch {
        // TOCTOU: file may have been deleted between existsSync and
        // statSync. Fall through — dir/name already default to the
        // parent directory, which the watch logic below handles.
      }
      if (!existsSync(dir)) continue
      try {
        ws.push(watch(dir, { persistent: false }, (_ev, f) => {
          if (name === null || f === name) fire()
        }))
      } catch {
        // Unwatchable (permissions, exotic fs). Slice still works; just not reactive.
      }
    }
    this.watchers.set(k, ws)
  }
}

export const home = new HomeStore()
