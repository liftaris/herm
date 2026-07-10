// Public plugin surface. A plugin is an async factory that receives a
// `HermPluginApi` and imperatively registers into extension points
// (slots, routes, commands, event listeners). The host grows by planting
// `<Slot name="x">` call sites, not by widening this type.
//
// Slot rendering uses `@opentui/react`'s `SlotRegistry`, which wraps each
// contribution in an error boundary keyed by plugin id, so one faulty
// plugin cannot take the shell down.

import type { ReactNode } from "react"
import type { CliRenderer } from "@opentui/core"
import type { ReactPlugin, SlotMode } from "@opentui/react"
import type { Theme } from "../theme"
import type { Gateway } from "../context/gateway"
import type { GatewayEvent } from "../context/wire"
import type { DialogContext } from "../ui/dialog"
import type { Keys } from "../keys"
import type { SelectOption } from "../ui/dialog-select"

export type { SlotMode, SelectOption }

export type Slots = {
  app_bottom: { sid: string; tab: number; streaming: boolean }
  sidebar_content: { sid: string }
  sidebar_footer: { sid: string }
  prompt_right: { sid: string }
  splash_footer: Record<string, never>
}

/** Context handed to slot renderers. Stable reference; `theme` is a live
 *  getter so retints propagate without rebuilding the registry. Slot
 *  renderers that need more than theme close over the `api` their
 *  plugin's factory received. */
export type SlotCtx = { readonly theme: Theme }

export type SlotPlugin = ReactPlugin<Slots, SlotCtx>

export type RouteContext = { focused: boolean }

export type RouteDef = {
  /** Stable name — also the `/name` slash target and TabBar label. */
  name: string
  description?: string
  render: (ctx: RouteContext) => ReactNode
}

export type Dispose = () => void | Promise<void>

export type Lifecycle = {
  /** Aborts when the plugin is deactivated. Race long-running async
   *  work against this. */
  readonly signal: AbortSignal
  /** Register a teardown callback. Runs in reverse registration order
   *  on deactivate, bounded by a shared 5s budget. Returns a canceller
   *  that drops the callback without running it. */
  onDispose(fn: Dispose): () => void
}

export type HermPluginApi = {
  readonly renderer: CliRenderer
  readonly theme: {
    readonly current: Theme
    readonly name: string
    readonly mode: "dark" | "light"
    set(name: string): boolean
    setMode(mode: "dark" | "light"): void
    has(name: string): boolean
  }
  readonly keys: Keys
  readonly ui: {
    readonly dialog: DialogContext
    toast(opts: { variant?: "info" | "error" | "warning" | "success"; title?: string; message: string }): void
    confirm(opts: { title: string; body: string; danger?: boolean }): Promise<boolean>
    prompt(opts: { title: string; label?: string; initial?: string }): Promise<string | null>
    alert(title: string, body: string): void
    select(opts: { title: string; options: ReadonlyArray<SelectOption>; placeholder?: string }): Promise<SelectOption | null>
  }
  /** Plugin-namespaced persistent KV, backed by `preferences.plugin[id]`. */
  readonly kv: {
    get<T>(key: string, fallback: T): T
    set(key: string, value: unknown): void
  }
  readonly client: Gateway
  readonly event: {
    on(fn: (ev: GatewayEvent) => void): () => void
  }
  readonly route: {
    register(defs: ReadonlyArray<RouteDef>): () => void
    navigate(name: string, sub?: number): void
    readonly current: string | undefined
  }
  readonly command: {
    register(cmds: ReadonlyArray<{
      title: string; value: string; description?: string; category?: string; onSelect: () => void
    }>): () => void
  }
  readonly slots: {
    register(p: Omit<SlotPlugin, "id"> & { order?: number }): () => void
  }
  readonly eikon: {
    /** Contribute a rasterizer to the Eikon tab. Scope-tracked —
     *  deactivating the plugin unregisters it. */
    rasterizer: { register(r: import("../utils/eikon-render").Rasterizer): () => void }
  }
  readonly lifecycle: Lifecycle
}

export type HermPlugin = {
  id: string
  /** Default enablement when no user override exists. */
  enabled?: boolean
  tui(api: HermPluginApi): void | Promise<void>
}

export type PluginStatus = {
  id: string
  enabled: boolean
  active: boolean
  error?: string
}
