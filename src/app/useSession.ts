// Session lifecycle: create, resume, switch, interrupt, branch, compress, undo.

import { useMemo, useCallback } from "react"
import * as preferences from "../context/preferences"
import { sdb } from "../service/sessions-db"
import { useGateway } from "../context/gateway"
import { transcriptToMessages } from "./turnReducer"
import type { Launch } from "./launch"
import type {
  SessionResumeResponse,
  SessionActivateResponse,
  SessionCreateResponse,
  SessionInfo,
  SessionInflightTurn,
  TranscriptMessage,
} from "../context/wire"
import type { Message, Usage } from "../types/message"

/** session.compress response shape. `messages` is compacted server context;
 *  the live chat transcript intentionally stays visually unchanged. */
type CompressResult = {
  status?: "compressed" | "skipped" | "preview" | "unsupported"
  removed?: number
  before_messages?: number
  after_messages?: number
  before_tokens?: number
  after_tokens?: number
  lines?: string[]
  message?: string
  messages?: TranscriptMessage[]
  info?: SessionInfo
  usage?: Usage
  summary?: {
    noop?: boolean
    headline?: string
    token_line?: string
    note?: string | null
  }
}

type Booted = { id: string; key: string; messages: Message[]; note?: string; info?: SessionInfo }
type Resumed = { id: string; key: string; messages: Message[]; info?: SessionInfo }
type Activated = { id: string; key: string; messages: Message[]; info?: SessionInfo; running: boolean; status?: string; startedAt?: number }
type Agents = { processes?: Array<{ status?: string }> }
type Close = { preserveBackground?: boolean }

export const normalize = (sid: string): string =>
  sid.trim().replace(/\.json$/i, "").replace(/^session_(?=\d{8}_)/, "")

type SessionOps = {
  /** Establish the initial session per launch intent. */
  boot: (launch: Launch) => Promise<Booted>
  create: () => Promise<{ id: string; key: string; info?: SessionInfo }>
  resume: (sid: string) => Promise<Resumed>
  activate: (sid: string) => Promise<Activated>
  /** Finalize a gateway session (best-effort — swallows errors). */
  close: (sid: string, opts?: Close) => Promise<boolean>
  interrupt: () => Promise<void>
  branch: (name?: string) => Promise<string | null>
  compress: (arg?: string) => Promise<CompressResult | null>
  undo: () => Promise<void>
}

export function useSession(): SessionOps {
  const gw = useGateway()

  const inflightMessages = (inflight?: SessionInflightTurn | null): Message[] => {
    const user = String(inflight?.user ?? "").trim()
    const assistant = String(inflight?.assistant ?? "")
    const messages: Message[] = []
    if (user) messages.push(...transcriptToMessages([{ role: "user", text: user }]))
    if (assistant || inflight?.streaming) messages.push(...transcriptToMessages([{ role: "assistant", text: assistant }]))
    return messages
  }

  const resume = useCallback(async (sid: string) => {
    // Normalize at the edge (argv / slash-arg can be `session_*.json`).
    // No tip-chasing here: Sessions-tab lineage walk and `/resume <id>`
    // pass exact ids on purpose; boot() resolves tips itself.
    const target = normalize(sid)
    const res = await gw.request<SessionResumeResponse>("session.resume", { session_id: target })
    const id = res.session_id
    const key = res.session_key ?? res.resumed ?? target
    gw.setSession(id)
    preferences.set("lastSessionId", key)
    const messages = res.messages?.length ? transcriptToMessages(res.messages) : []
    return { id, key, messages, info: res.info }
  }, [gw])

  // No `cols` param and no `terminal.resize` RPC on SIGWINCH: herm renders
  // markdown via OpenTUI's <markdown> from raw payload.text, so wrapping is
  // handled client-side by the layout tree on resize. The agent-side width
  // (session["cols"], fed to make_stream_renderer) only populates the
  // payload.rendered field that herm ignores, plus render_diff for the
  // checkpoint diff RPC — both default-80 is fine for our flow.
  const create = useCallback(async () => {
    const res = await gw.request<SessionCreateResponse>("session.create", {})
    const key = res.stored_session_id ?? res.session_id
    gw.setSession(res.session_id)
    preferences.set("lastSessionId", key)
    return { id: res.session_id, key, info: res.info }
  }, [gw])

  const activate = useCallback(async (sid: string): Promise<Activated> => {
    const target = normalize(sid)
    const res = await gw.request<SessionActivateResponse>("session.activate", { session_id: target })
    const id = res.session_id
    const key = res.session_key ?? id
    gw.setSession(id)
    preferences.set("lastSessionId", key)
    const history = res.messages?.length ? transcriptToMessages(res.messages) : []
    const running = Boolean(res.running || res.status === "working" || res.status === "waiting")
    return {
      id,
      key,
      info: res.info,
      messages: [...history, ...inflightMessages(res.inflight)],
      running,
      startedAt: res.started_at ? res.started_at * 1000 : undefined,
      status: res.status,
    }
  }, [gw])

  // Finalize a gateway session: marks the DB row ended, tears down the
  // per-session slash_worker subprocess, unregisters the approval
  // notifier, and drops the AIAgent from the gateway's `_sessions` map.
  // Without this, /new and session-switch leak one HermesCLI child
  // (slash_worker) + one live AIAgent per hop until quit, and the row's
  // `ended_at IS NULL` throws off lineage classification in Sessions
  // tab (sessions-db.ts SUB/CONT predicates). Parity with Ink TUI's
  // useSessionLifecycle.closeSession. Pass `session_id` explicitly so
  // auto-injection doesn't close whatever sid the gateway already
  // switched to.
  const busy = useCallback(async () => {
    try {
      const res = await gw.request<Agents>("agents.list")
      return res.processes?.some(p => p.status === "running") ?? false
    } catch { return true }
  }, [gw])

  const close = useCallback(async (sid: string, opts?: Close) => {
    if (!sid) return false
    // Hermes Agent's session.close tears down the AIAgent, which also kills
    // terminal(background=true) processes owned by that agent. The gateway
    // only exposes a global agents.list summary today, not owner session keys,
    // so preserve the outgoing live session while any durable process is
    // running rather than risking SIGTERM on a watcher during session switch.
    if (opts?.preserveBackground && await busy()) return false
    try {
      await gw.request("session.close", { session_id: sid })
      return true
    } catch { return false }
  }, [gw, busy])

  const boot = useCallback(async (launch: Launch): Promise<Booted> => {
    const fresh = async (note?: string) => ({ ...(await create()), messages: [], note })

    if (launch.mode === "resume") {
      const target = launch.sid ?? sdb.lastReal()?.id
      if (!target) return fresh("no prior session to resume — starting fresh")
      try { return await resume(target) }
      catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return fresh(`resume ${target} failed: ${msg} — starting fresh`)
      }
    }

    // mode:"new" — bare launch is fresh unless we can reuse our own
    // abandoned root stub. Do not chase compression tips here: a stored
    // old continuation can point at a 0-msg child and silently keep bare
    // `herm` attached to old lineage.
    const last = preferences.get("lastSessionId")
    const row = last ? sdb.byId(last) : null
    if (row?.message_count === 0 && row.parent_session_id == null) {
      try { return await resume(row.id) } catch { /* fall through */ }
    }
    return fresh()
  }, [create, resume])

  const interrupt = useCallback(async () => {
    await gw.request("session.interrupt")
  }, [gw])

  const branch = useCallback(async (name?: string) => {
    const res = await gw.request<{ session_id?: string }>("session.branch", name ? { name } : {})
    return res.session_id ?? null
  }, [gw])

  const compress = useCallback(async (arg = ""): Promise<CompressResult | null> => {
    const raw = arg.trim()
    const params = raw ? { raw_args: raw, focus_topic: raw } : {}
    return gw.request<CompressResult>("session.compress", params)
  }, [gw])

  const undo = useCallback(async () => {
    await gw.request("session.undo")
  }, [gw])

  return useMemo(
    () => ({ boot, create, resume, activate, close, interrupt, branch, compress, undo }),
    [boot, create, resume, activate, close, interrupt, branch, compress, undo],
  )
}
