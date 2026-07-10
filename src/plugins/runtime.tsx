// Plugin runtime. `<PluginProvider>` sits inside the full provider stack,
// builds the shared api from context, constructs the `SlotRegistry`, and
// sequentially activates the supplied plugin list (order = precedence).
// `usePlugins()` exposes the bound `<Slot>`, registered routes, and
// activate/deactivate controls to the shell.

import { Component, createContext, useEffect, useMemo, useReducer, useRef, type ErrorInfo, type ReactNode } from "react"
import { createReactSlotRegistry, createSlot, useRenderer, type ReactSlotComponent } from "@opentui/react"
import { makeUse } from "../context/helper"
import { useTheme, type Theme } from "../theme"
import { useKeys } from "../keys"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useCommand } from "../ui/command"
import { useGateway } from "../context/gateway"
import * as prefs from "../context/preferences"
import { createApi, type ApiInput } from "./api"
import { createScope, type Scope } from "./scope"
import { INTERNAL } from "./internal"
import type { HermPlugin, HermPluginApi, PluginStatus, RouteContext, RouteDef, SlotCtx, SlotPlugin, Slots } from "./types"

const KV_ENABLED = "enabled"

type Entry = {
  plugin: HermPlugin
  enabled: boolean
  scope?: Scope
  error?: string
}

export type PluginCtx = {
  Slot: ReactSlotComponent<Slots>
  /** Registered plugin routes, in registration order. */
  routes: ReadonlyArray<RouteDef>
  /** Wire the shell's tab navigator. Called once by AppInner. */
  bind(nav: (tab: number, sub: number) => void, current: () => string | undefined): void
  status(): ReadonlyArray<PluginStatus>
  has(slot: keyof Slots): boolean
  activate(id: string): Promise<boolean>
  deactivate(id: string): Promise<boolean>
}

const Ctx = createContext<PluginCtx | null>(null)

function fail(msg: string, err?: unknown) {
  const tail = err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : ""
  console.error(msg + tail)
}

const RouteBody = (props: { render: RouteDef["render"]; ctx: RouteContext }) => props.render(props.ctx)

class RouteBoundary extends Component<
  { id: string; name: string; children: ReactNode },
  { error?: Error }
> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error) { return { error } }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    fail(`[plugin:${this.props.id}] render error in route "${this.props.name}"`, error)
  }

  render() {
    if (this.state.error)
      return <text>{`Plugin ${this.props.id} route ${this.props.name}: ${this.state.error.message}`}</text>
    return this.props.children
  }
}

function enabledMap(): Record<string, boolean> {
  const bag = prefs.get("plugin") as Record<string, unknown> | undefined
  const v = bag?.[KV_ENABLED]
  return (v && typeof v === "object") ? v as Record<string, boolean> : {}
}

function persist(id: string, on: boolean) {
  const bag = (prefs.get("plugin") as Record<string, unknown> | undefined) ?? {}
  const map = { ...enabledMap(), [id]: on }
  prefs.set("plugin", { ...bag, [KV_ENABLED]: map })
}

/** Wrap the shared api with per-plugin scope: every register() return is
 *  tracked, slots.register stamps the plugin id, kv is namespaced, and
 *  lifecycle carries this scope's AbortSignal. */
function scoped(base: HermPluginApi, reg: ReturnType<typeof createReactSlotRegistry<Slots, SlotCtx>>,
                id: string, scope: Scope): HermPluginApi {
  let n = 0
  return {
    ...base,
    slots: {
      register(p) {
        const sid = n++ ? `${id}:${n}` : id
        return scope.track(reg.register({ ...p, id: sid } as SlotPlugin))
      },
    },
    route: {
      register: defs => scope.track(base.route.register(defs.map(def => ({
        ...def,
        render: ctx => (
          <RouteBoundary id={id} name={def.name}>
            <RouteBody render={def.render} ctx={ctx} />
          </RouteBoundary>
        ),
      })))),
      navigate: base.route.navigate,
      get current() { return base.route.current },
    },
    event: {
      on: fn => scope.track(base.event.on(fn)),
    },
    command: {
      register: cmds => scope.track(base.command.register(cmds)),
    },
    eikon: {
      rasterizer: { register: r => scope.track(base.eikon.rasterizer.register(r)) },
    },
    kv: {
      get: (key, fb) => base.kv.get(`${id}.${key}`, fb),
      set: (key, v) => base.kv.set(`${id}.${key}`, v),
    },
    lifecycle: scope.lifecycle,
  }
}

// createSlotRegistry stores one registry per renderer and throws if a
// second call passes a different context object. Intern the SlotCtx at
// module scope so PluginProvider remounts reuse it; swap the themeRef
// cell each call so the getter reads the live theme.
type Cell = { ctx: SlotCtx; themeRef: { current: { theme: Theme } } }
const CELLS = new WeakMap<object, Cell>()
function ctxFor(renderer: object, themeRef: Cell["themeRef"]): SlotCtx {
  const hit = CELLS.get(renderer)
  if (hit) { hit.themeRef = themeRef; return hit.ctx }
  const cell: Cell = { themeRef, ctx: {} as SlotCtx }
  Object.defineProperty(cell.ctx, "theme",
    { get: () => cell.themeRef.current.theme, enumerable: true })
  CELLS.set(renderer, cell)
  return cell.ctx
}

export function PluginProvider(props: { children: ReactNode; plugins?: ReadonlyArray<HermPlugin> }) {
  const list = props.plugins ?? INTERNAL
  const renderer = useRenderer()
  const themeCtx = useTheme()
  const keys = useKeys()
  const dialog = useDialog()
  const toast = useToast()
  const cmd = useCommand()
  const gw = useGateway()

  // Ref-backed live sources so the shared api object stays stable while
  // its getters see the latest React state on every access.
  const themeRef = useRef(themeCtx); themeRef.current = themeCtx
  const keysRef = useRef(keys); keysRef.current = keys
  const gwRef = useRef(gw); gwRef.current = gw
  const navRef = useRef<ApiInput["nav"]["current"]>(null)
  const curRef = useRef<ApiInput["cur"]["current"]>(null)

  const routes = useRef(new Map<string, RouteDef>()).current
  const [rev, bump] = useReducer((x: number) => x + 1, 0)

  const reg = useMemo(
    () => createReactSlotRegistry<Slots, SlotCtx>(
      renderer,
      ctxFor(renderer, themeRef),
      { onPluginError: e => fail(`[plugin:${e.pluginId}] ${e.phase} error in slot "${e.slot}"`, e.error) },
    ),
    [renderer],
  )
  const Slot = useMemo(() => createSlot<Slots, SlotCtx>(reg), [reg])

  const api = useMemo<HermPluginApi>(() => createApi({
    renderer,
    theme: themeRef,
    keys: keysRef,
    dialog,
    toast,
    gw: gwRef,
    cmd,
    routes,
    bump,
    nav: navRef,
    cur: curRef,
  // dialog/toast/cmd are memoized in their providers; identity is stable.
  }), [renderer, dialog, toast, cmd, routes])

  const entries = useRef(new Map<string, Entry>())
  const [gen, force] = useReducer((x: number) => x + 1, 0)

  const activate = async (id: string, write = true): Promise<boolean> => {
    const e = entries.current.get(id)
    if (!e) return false
    e.enabled = true
    if (write) persist(id, true)
    if (e.scope) return true
    const scope = createScope(id, fail)
    const ok = await Promise.resolve()
      .then(() => e.plugin.tui(scoped(api, reg, id, scope)))
      .then(() => true)
      .catch(err => { fail(`[plugin:${id}] activation failed`, err); e.error = String((err as Error)?.message ?? err); return false })
    if (!ok || !e.enabled) { await scope.dispose(); force(); return ok && true }
    e.scope = scope
    e.error = undefined
    force()
    return true
  }

  const deactivate = async (id: string, write = true): Promise<boolean> => {
    const e = entries.current.get(id)
    if (!e) return false
    e.enabled = false
    if (write) persist(id, false)
    const scope = e.scope
    e.scope = undefined
    if (scope) await scope.dispose()
    force()
    return true
  }

  // Sequential activation on mount. A plugin that errors is skipped; the
  // rest proceed. Teardown on unmount (test renderer destroy, hot reload).
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    const on = enabledMap()
    for (const p of list) entries.current.set(p.id, { plugin: p, enabled: on[p.id] ?? p.enabled ?? true })
    void (async () => {
      for (const [id, e] of entries.current) if (e.enabled) await activate(id, false)
    })()
    return () => {
      for (const [, e] of entries.current) void e.scope?.dispose()
      entries.current.clear()
      routes.clear()
      reg.clear()
    }
  }, [])

  const value = useMemo<PluginCtx>(() => ({
    Slot,
    routes: [...routes.values()],
    bind: (nav, current) => {
      navRef.current = nav
      curRef.current = current
    },
    status: () => [...entries.current.values()].map(e => ({
      id: e.plugin.id, enabled: e.enabled, active: !!e.scope, error: e.error,
    })),
    has: slot => reg.resolveEntries(slot).length > 0,
    activate: id => activate(id),
    deactivate: id => deactivate(id),
  // `routes` is a stable Map ref; snapshot rebuilds on `rev`. `gen`
  // bumps on (de)activate so consumers reading `status()` re-render.
  }), [Slot, routes, rev, gen])

  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>
}

export const usePlugins = makeUse(Ctx, "usePlugins")

export * as plugins from "./runtime"
