// GatewayClient exposed via React context. The provider accepts an
// injected client so tests can substitute a MockGateway without
// spawning the Python tui_gateway subprocess.

import { createContext, useContext, useEffect, useRef, useState, useMemo, useCallback } from "react"
import type { ReactNode } from "react"
import { EventEmitter } from "events"
import { GatewayClient, type GatewayEventSource } from "../context/gateway-client"
import type { GatewayEvent } from "../context/wire"

/** Minimal surface consumers depend on. GatewayClient satisfies this. */
export interface Gateway extends EventEmitter {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  setSession(sid: string): void
  start(): void
  drain(): void
  kill(): void
  tail(n?: number): string
  diagnose?(ev: GatewayEvent, source?: GatewayEventSource): void
  readonly ready: boolean
}

type Ctx = {
  client: Gateway
  ready: boolean
  /** Kill and respawn the gateway subprocess. Reads process.env fresh —
   *  call after rehome() so the new process sees the new HERMES_HOME. */
  restart: (mode?: "resume" | "new") => void
}

const Gw = createContext<Ctx | null>(null)

export const GatewayProvider = ({ client, children }: { client?: Gateway; children: ReactNode }) => {
  const ref = useRef<Gateway | null>(null)
  if (!ref.current) ref.current = client ?? new GatewayClient()
  const [ready, setReady] = useState(ref.current.ready)
  const retry = useRef<{ timer?: ReturnType<typeof setTimeout>; attempts: number }>({ attempts: 0 })

  useEffect(() => {
    const c = ref.current!
    const onEvent = (ev: GatewayEvent) => {
      if (ev.type === "gateway.ready" || ev.type === "session.info") setReady(true)
      if (ev.type === "session.info") {
        if (retry.current.timer) clearTimeout(retry.current.timer)
        retry.current = { attempts: 0 }
      }
    }
    const onExit = () => {
      setReady(false)
      if (retry.current.timer) clearTimeout(retry.current.timer)
      if (retry.current.attempts >= 3) return
      const delay = 250 * (2 ** retry.current.attempts++)
      retry.current.timer = setTimeout(() => c.start(), delay)
    }
    c.on("event", onEvent)
    c.on("exit", onExit)
    c.start()
    c.drain()
    return () => {
      c.off("event", onEvent)
      c.off("exit", onExit)
      if (retry.current.timer) clearTimeout(retry.current.timer)
      c.removeAllListeners()
      c.kill()
    }
  }, [])

  const restart = useCallback((mode: "resume" | "new" = "resume") => {
    if (retry.current.timer) clearTimeout(retry.current.timer)
    retry.current = { attempts: 0 }
    setReady(false)
    ref.current!.emit("restart", mode)
    ref.current!.start()
  }, [])

  const value = useMemo<Ctx>(() => ({ client: ref.current!, ready, restart }), [ready, restart])
  return <Gw.Provider value={value}>{children}</Gw.Provider>
}

export function useGateway(): Gateway {
  const ctx = useContext(Gw)
  if (!ctx) throw new Error("useGateway() must be inside <GatewayProvider>")
  return ctx.client
}

/**
 * Subscribe to all gateway events. The first subscription drains any
 * events buffered before React mounted, so nothing is lost between
 * `client.start()` and component wiring.
 */
export function useGatewayEvent(handler: (ev: GatewayEvent) => void): void {
  const ctx = useContext(Gw)
  if (!ctx) throw new Error("useGatewayEvent() must be inside <GatewayProvider>")
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const c = ctx.client
    const fn = (ev: GatewayEvent) => ref.current(ev)
    c.on("event", fn)
    c.drain()
    return () => { c.off("event", fn) }
  }, [ctx.client])
}

/** True once gateway.ready or session.info has fired. */
export function useGatewayReady(): boolean {
  const ctx = useContext(Gw)
  if (!ctx) throw new Error("useGatewayReady() must be inside <GatewayProvider>")
  return ctx.ready
}

/** Kill + respawn the gateway subprocess under the current process.env. */
export function useGatewayRestart(): (mode?: "resume" | "new") => void {
  const ctx = useContext(Gw)
  if (!ctx) throw new Error("useGatewayRestart() must be inside <GatewayProvider>")
  return ctx.restart
}
