// Session lifecycle: create, resume, switch, interrupt, branch, compress, undo.

import { useMemo, useCallback } from "react"
import * as preferences from "../utils/preferences"
import * as sdb from "../utils/sessions-db"
import { useGateway } from "./gateway"
import { transcriptToMessages } from "./turnReducer"
import type { Launch } from "./launch"
import type { SessionResumeResponse, SessionCreateResponse } from "../utils/gateway-types"
import type { Message } from "../types/message"

/** session.compress response shape — see upstream fc7f55f49. */
export type CompressResult = {
  status?: "compressed" | "skipped"
  removed?: number
  before_messages?: number
  after_messages?: number
  before_tokens?: number
  after_tokens?: number
  summary?: {
    noop?: boolean
    headline?: string
    token_line?: string
    note?: string | null
  }
}

type Booted = { id: string; messages: Message[]; note?: string }

/** Strip a `session_*.json` filename wrapper down to the bare DB id.
 *  Lets users paste either `20260509_002407_e8b6e4` or
 *  `session_20260509_002407_e8b6e4.json` into `/resume` interchangeably. */
export const normalizeSessionId = (input: string): string =>
  input.trim().replace(/\.json$/i, "").replace(/^session_(?=\d{8}_)/, "")

type SessionOps = {
  /** Establish the initial session per launch intent. */
  boot: (launch: Launch) => Promise<Booted>
  create: () => Promise<string>
  resume: (sid: string) => Promise<{ id: string; messages: Message[] }>
  interrupt: () => Promise<void>
  branch: (name?: string) => Promise<string | null>
  compress: () => Promise<CompressResult | null>
  undo: () => Promise<void>
}

export function useSession(): SessionOps {
  const gw = useGateway()

  const resume = useCallback(async (sid: string) => {
    // Two normalizations before we hit the gateway:
    //  1. Strip session_*.json wrappers so pasted filenames work.
    //  2. Walk the local compression chain. The user typically remembers
    //     a chain root id (visible in the picker, in `lastSessionId`,
    //     or pasted from a transcript file), but only the live tip is
    //     actually resumable. Without this, a resume targeting an
    //     ended parent silently starts fresh.
    const raw = normalizeSessionId(sid)
    const target = sdb.byId(raw) ? sdb.resolveChainTip(raw) : raw
    const res = await gw.request<SessionResumeResponse>("session.resume", { session_id: target })
    const id = res.session_id
    gw.setSession(id)
    preferences.set("lastSessionId", res.resumed ?? target)
    const messages = res.messages?.length ? transcriptToMessages(res.messages) : []
    return { id, messages }
  }, [gw])

  const create = useCallback(async () => {
    const res = await gw.request<SessionCreateResponse>("session.create", {})
    gw.setSession(res.session_id)
    return res.session_id
  }, [gw])

  const boot = useCallback(async (launch: Launch): Promise<Booted> => {
    const fresh = async (note?: string) => ({ id: await create(), messages: [], note })
    // Common fallback: try the lastReal chain tip; on failure surface
    // the actual error reason in the note instead of swallowing it,
    // so users know whether the gateway said "not found" vs a transient
    // network blip vs a permission issue.
    const latest = async (note = "no prior session to resume — starting fresh") => {
      const row = sdb.lastReal()
      if (!row) return fresh(note)
      try { return await resume(row.id) }
      catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        return fresh(`resume ${row.id} failed: ${reason} — starting fresh`)
      }
    }

    if (launch.mode === "resume") {
      const target = launch.sid ? normalizeSessionId(launch.sid) : sdb.lastReal()?.id
      if (!target) return fresh("no prior session to resume — starting fresh")
      try { return await resume(target) }
      catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        return fresh(`resume ${target} failed: ${reason} — starting fresh`)
      }
    }

    // mode:"new" — reuse our own abandoned empty stub instead of
    // creating another row every launch. Resolve the stored
    // lastSessionId through any compression chain first; we want to
    // act on the *tip*, not the parent the preference happens to
    // point at:
    //   • tip has messages → resume it (it's the live conversation)
    //   • tip has 0 messages → resume the empty stub; on failure fall
    //     back to lastReal()
    //   • no tip in db → fall back to lastReal()
    // Without resolveChainTip, a stored parent id (e.g. an ended
    // continuation with hundreds of messages) bypasses the stub-reuse
    // check, the resume path is skipped, and a fresh stub is created
    // — silently abandoning the active session.
    const last = preferences.get("lastSessionId")
    const tip = last ? sdb.resolveChainTip(last) : null
    if (tip) {
      const tipRow = sdb.byId(tip)
      if (!tipRow) return latest()
      if (tipRow.message_count === 0) {
        try { return await resume(tip) } catch { /* fall through */ }
        return latest("resume empty stub failed — starting fresh")
      }
      return resume(tip)
    }
    return latest()
  }, [create, resume])

  const interrupt = useCallback(async () => {
    try { await gw.request("session.interrupt") } catch {}
  }, [gw])

  const branch = useCallback(async (name?: string) => {
    try {
      const res = await gw.request<{ session_id?: string }>("session.branch", name ? { name } : {})
      return res.session_id ?? null
    } catch { return null }
  }, [gw])

  const compress = useCallback(async (): Promise<CompressResult | null> => {
    try { return await gw.request<CompressResult>("session.compress") }
    catch { return null }
  }, [gw])

  const undo = useCallback(async () => {
    try { await gw.request("session.undo") } catch {}
  }, [gw])

  return useMemo(
    () => ({ boot, create, resume, interrupt, branch, compress, undo }),
    [boot, create, resume, interrupt, branch, compress, undo],
  )
}
