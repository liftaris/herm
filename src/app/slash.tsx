// Slash dispatch + command-palette registration. Pulled out of AppInner
// so the ~40 case handlers and their imports don't weigh on app.tsx.
//
// `run` reads every per-render value through `ctx.current`, so it is
// identity-stable (empty deps) and can be passed as `<Composer onSlash>`
// without breaking the memo firewall. This replaces the previous
// 20-dep useCallback whose identity churned on every session.info.

import React from "react"
import { useCallback, useEffect, useRef, type RefObject } from "react"
import { useRenderer } from "@opentui/react"
import { useGateway } from "../context/gateway"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useCommand } from "../ui/command"
import { useTheme } from "../theme"
import { DialogSelect } from "../ui/dialog-select"
import { trunc, ago } from "../ui/fmt"
import { HelpDialog } from "../dialogs/help"
import { openKeys } from "../dialogs/keys"
import { openLogs } from "../dialogs/logs"
import { openThemePicker } from "../dialogs/theme-picker"
import { openModelPicker } from "../dialogs/model-picker"
import { openEikonPicker } from "../dialogs/eikon-picker"
import { openTextPrompt } from "../dialogs/text-prompt"
import { openConfirm } from "../dialogs/confirm"
import { openRollback } from "../dialogs/rollback"
import { openHistory } from "../dialogs/history"
import { openStatus, openUsage, openProfile } from "../dialogs/info"
import { openChafa } from "../dialogs/chafa"
import { skins, mode as skinMode, type SkinState } from "../context/skin"
import { copyText as clipCopy } from "../utils/clipboard"
import * as preferences from "../context/preferences"
import { redraw } from "./useAppKeys"
import { quit } from "./exit"
import { Stash } from "./stash"
import { useBackground } from "./background"
import { useHome, home } from "../home"
import { TAB_SLASH } from "./tabs"
import { transcriptToMessages, type Action, type TurnState } from "./turnReducer"
import type { SlashCommand } from "./slashCommands"
import type { ComposerHandle } from "../components/chat/Composer"
import type { SessionInfo, TranscriptMessage, ImageAttachResponse } from "../context/wire"
import type { Message, Usage } from "../types/message"
import { text as msgText } from "../types/message"
import type { useSession } from "./useSession"
import type { SessionCapabilities } from "./sessionCapabilities"

export type SlashCtx = {
  dispatch: React.Dispatch<Action>
  session: ReturnType<typeof useSession>
  turnRef: RefObject<TurnState>
  queueRef: RefObject<string[]>
  sendRef: RefObject<(raw: string) => void>
  composer: RefObject<ComposerHandle | null>
  summoned: RefObject<boolean>
  /** Tails popped by /undo (LIFO). /redo replays the head user
   *  message's text; any other send clears it. Client-only —
   *  gateway session.undo hard-deletes with no unrevert. */
  undone: RefObject<Message[][]>

  capabilities: SessionCapabilities
  info: SessionInfo | null
  sid: string
  resumeId: string
  title: string
  skin: SkinState

  setQueue: React.Dispatch<React.SetStateAction<string[]>>
  setFocusRegion: (r: "input" | "content") => void
  setSplash: (v: boolean) => void
  setAttachments: React.Dispatch<React.SetStateAction<ImageAttachResponse[]>>
  setInfo: (i: SessionInfo) => void
  setUsage: React.Dispatch<React.SetStateAction<Usage | undefined>>
  setTitle: (t: string) => void

  newSession: () => Promise<void>
  switchSession: (id: string) => Promise<void>
  activateSession: (id: string) => Promise<boolean>
  rewind: (m: Message) => Promise<boolean>
  goTo: (tab: number, sub: number) => void
  attachClipboard: () => void
  voiceToggle: (action: string, sid: string) => Promise<void>
}

const AGGRESSIVE = "--aggressive is not supported; use '/compress here [N]' to keep only recent exchanges, or /undo to drop turns."

function flags(arg: string) {
  const kept: string[] = []
  const preview = { on: false, aggressive: false }
  for (const tok of arg.split(/\s+/).filter(Boolean)) {
    const low = tok.toLowerCase()
    if (low === "--preview" || low === "--dry-run" || low === "--dryrun") preview.on = true
    else if (low === "--aggressive") preview.aggressive = true
    else kept.push(tok)
  }
  return { arg: kept.join(" "), preview: preview.on, aggressive: preview.aggressive }
}

function partial(arg: string) {
  const text = arg.trim()
  if (!text) return { on: false, keep: 2, focus: "" }
  const norm = text.toLowerCase().startsWith("up to here") ? text.slice(6).trim() : text
  const bits = norm.toLowerCase().split(/\s+/)
  const keep = (v: string | undefined) => Math.min(Math.max(parseInt(v ?? "", 10) || 2, 1), 100)
  if (bits[0] === "here") return { on: true, keep: keep(bits[1]), focus: "" }
  if ((bits[0] === "--keep" || bits[0] === "-k") && bits[1]) return { on: true, keep: keep(bits[1]), focus: "" }
  if (bits[0]?.startsWith("--keep=")) return { on: true, keep: keep(bits[0].split("=", 2)[1]), focus: "" }
  return { on: false, keep: 2, focus: text }
}

export function compressPreview(arg: string, msgs: Message[]): string[] | null {
  const f = flags(arg)
  if (f.aggressive && !f.preview) return [AGGRESSIVE]
  if (!f.preview) return null
  const p = partial(f.arg)
  const at = p.on ? [...msgs].reverse().reduce((acc, m, i) => {
    if (acc.length < p.keep && m.role === "user") return [...acc, msgs.length - 1 - i]
    return acc
  }, [] as number[]).at(-1) : undefined
  const head = at === undefined || at === 0 ? msgs : msgs.slice(0, at)
  const tail = at === undefined || at === 0 ? [] : msgs.slice(at)
  const lines = [
    "Preview — no changes made.",
    `Would compress ${head.length} of ${msgs.length} message(s) (~${Math.ceil(msgs.map(msgText).join("\n\n").length / 4).toLocaleString()} tokens currently in context).`,
  ]
  if (p.on && tail.length)
    lines.push(`Boundary: keeping the last ${p.keep} exchange(s) (${tail.length} message(s)) verbatim.`)
  else if (p.on)
    lines.push("Boundary: 'here' split would keep everything — falling back to full compression.")
  if (p.focus) lines.push(`Focus topic: "${p.focus}"`)
  lines.push("Run the command again without --preview to apply.")
  if (f.aggressive) lines.push(AGGRESSIVE)
  return lines
}

export function useSlash(c: SlashCtx): (cmd: SlashCommand, arg?: string) => void {
  const gw = useGateway()
  const dialog = useDialog()
  const toast = useToast()
  const themeCtx = useTheme()
  const cmd = useCommand()
  const renderer = useRenderer()
  const cfg = useHome("config")
  const bg = useBackground()

  const ctx = useRef(c); ctx.current = c
  const gate = useRef(cfg); gate.current = cfg

  // `/clear`, `/new`, `/undo` discard conversation state. Mirrors
  // upstream's `approvals.destructive_slash_confirm` config gate
  // (b9c001116) — upstream's gateway-side check never fires for herm
  // because these commands short-circuit in `run` below (local
  // intercept, never reaches gateway). `HERMES_TUI_NO_CONFIRM` is the
  // kill switch. Arg `now|once|approve|yes|always` skips the dialog;
  // `always` also flips the config key off, same shape as /reload-mcp.
  const destructive = useCallback((
    arg: string,
    opts: { title: string; body: string; yes: string },
    action: () => void,
  ) => {
    const a = arg.trim().toLowerCase()
    const skip = a === "now" || a === "once" || a === "approve" || a === "yes" || a === "always"
    const on = gate.current?.approvals?.destructive_slash_confirm ?? true
    const bypass = !on || process.env.HERMES_TUI_NO_CONFIRM === "1"
    const persist = a === "always"
    const fire = () => {
      if (persist) {
        void import("../config/lane").then(({ writeConfig }) =>
          writeConfig(gw, [{ key: "approvals.destructive_slash_confirm", to: false }])
            .then(r => {
              if (r.failed.length) {
                toast.show({ variant: "warning", message: `couldn't persist: ${r.failed[0].err}` })
                return
              }
              home.invalidate("config")
              toast.show({ variant: "success", message: `${opts.yes} · future runs silent` })
            })
            .catch((e: Error) => toast.show({ variant: "error", message: e.message })))
      }
      action()
    }
    if (skip || bypass) return fire()
    void openConfirm(dialog, { title: opts.title, body: opts.body, yes: opts.yes, danger: true })
      .then(ok => { if (ok) fire() })
  }, [gw, dialog, toast])

  const pickEikon = useCallback(() =>
    openEikonPicker(dialog, (n) => preferences.set("eikon", n)), [dialog])

  const applyTitle = useCallback((t: string) => {
    gw.request<{ title: string }>("session.title", { title: t })
      .then(r => {
        ctx.current.setTitle(r.title)
        ctx.current.dispatch({ kind: "system", text: `Title: ${r.title}` })
      })
      .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
  }, [gw, toast])

  // Manual compression mutates server context only; keep the live chat
  // transcript visually stable, matching auto-compression.
  const runCompress = useCallback(async (arg = "") => {
    const raw = arg.trim()
    const pv = compressPreview(raw, ctx.current.turnRef.current.messages)
    if (pv) {
      ctx.current.dispatch({ kind: "system", text: pv.join("\n") })
      toast.show({ variant: pv.length === 1 ? "warning" : "info",
        message: pv.length === 1 ? "compress unsupported" : "Preview — no changes made" })
      return
    }
    toast.show({ variant: "info", message: "Compressing session…" })
    const r = await ctx.current.session.compress(raw).catch((err: Error) => {
      toast.show({ variant: "error", message: err.message })
      return null
    })
    if (!r) return
    if (r.info) ctx.current.setInfo(r.info)
    const out = r.lines?.length ? r.lines : r.message ? [r.message] : []
    if (r.status === "preview" || r.status === "unsupported" || out.length) {
      if (out.length) ctx.current.dispatch({ kind: "system", text: out.join("\n") })
      toast.show({ variant: r.status === "unsupported" ? "warning" : "info",
        message: r.status === "unsupported" ? "compress unsupported" : "Preview — no changes made" })
      return
    }
    // r.usage.context_used reads comp.last_prompt_tokens which is set by
    // the last *model turn*, not updated by compression. r.after_tokens
    // IS the fresh rough estimate of the compacted transcript, so splice
    // it over context_used so the gauge drops now instead of after the
    // next turn (gh#20).
    ctx.current.setUsage(u => {
      const base = r.usage ?? u
      const max = r.usage?.context_max ?? u?.context_max
      if (typeof r.after_tokens !== "number" || typeof max !== "number") return base
      return { ...(base ?? { input: 0, output: 0, total: 0 }),
               context_used: r.after_tokens, context_max: max }
    })
    if (!r.summary) return
    const s = r.summary
    if (s.noop) {
      toast.show({ variant: "info",
        message: s.headline ?? `No changes · ~${r.before_tokens ?? 0} tokens` })
      return
    }
    const lines = [s.headline, s.token_line, s.note].filter(Boolean).join("\n")
    if (lines) ctx.current.dispatch({ kind: "system", text: lines })
    toast.show({ variant: "success",
      message: s.headline ?? `Compressed ${r.before_messages ?? 0}→${r.after_messages ?? 0} messages` })
  }, [toast])

  const branch = useCallback((name?: string) => {
    const x = ctx.current
    void x.session.branch(name?.trim() || undefined)
      .then(id => id
        ? void x.activateSession(id)
        : toast.show({ variant: "error", message: "branch failed" }))
      .catch((err: Error) => toast.show({ variant: "error", message: err.message }))
  }, [toast])

  const run = useCallback((c: SlashCommand, arg = "") => {
    const x = ctx.current
    if (c.target === "local") {
      switch (c.name) {
        case "clear":
          destructive(arg,
            { title: "Clear session?", body: "Discards the in-memory transcript. Your session on disk is unchanged; reload to restore.", yes: "clear" },
            () => x.dispatch({ kind: "reset" }))
          return
        case "new":
          destructive(arg,
            { title: "Start a new session?", body: "Ends the current session and starts a fresh one. The existing session remains saved and resumable.", yes: "new session" },
            () => { void x.newSession() })
          return
        case "theme": {
          const name = arg.trim()
          if (!name) { openThemePicker(dialog, themeCtx); return }
          const mode = name.toLowerCase()
          if (mode === "dark" || mode === "light") {
            themeCtx.setMode(mode)
            x.dispatch({ kind: "system", text: `theme mode → ${mode}` })
            return
          }
          if (!themeCtx.set(name)) {
            toast.show({ variant: "error", message: `unknown theme: ${name}` })
            return
          }
          x.dispatch({ kind: "system", text: `theme → ${name}` })
          return
        }
        case "help": dialog.replace(<HelpDialog />); return
        case "keys": openKeys(dialog); return
        case "logs": openLogs(dialog); return
        case "title":
          if (arg) { applyTitle(arg); return }
          openTextPrompt(dialog, { title: "Session Title", initial: x.title })
            .then(v => { if (v) applyTitle(v) })
          return
        case "rollback": openRollback(dialog, gw, toast); return
        case "history": openHistory(dialog, gw); return
        case "status": openStatus(dialog, x.info, x.sid); return
        case "usage": openUsage(dialog, gw); return
        case "profile": openProfile(dialog); return
        case "journey": x.goTo(TAB_SLASH.journey.tab, TAB_SLASH.journey.sub); return
        case "chafa":
          if (!arg.trim()) { toast.show({ variant: "info", message: "usage: /chafa <path>" }); return }
          openChafa(dialog, arg.trim())
          return
        case "splash": x.summoned.current = true; x.setSplash(true); return
        case "skin": {
          const name = arg.trim()
          const list = skins()
          if (!name) {
            x.dispatch({ kind: "system",
              text: `skin: ${x.skin.skin?.name ?? "—"}\n  ${list.join("  ")}` })
            return
          }
          if (!list.includes(name)) {
            toast.show({ variant: "error", message: `unknown skin: ${name}` })
            return
          }
          // Gateway write emits skin.changed → setSkin → eikon effect
          // re-resolves via bundledEikonPath(name). Clearing the pref
          // lets that precedence take over; themeCtx.set is a no-op if
          // no herm theme exists for this skin yet.
          gw.request<{ value?: string; warning?: string }>("config.set",
            { key: "skin", value: name })
            .then(r => {
              if (r.warning) toast.show({ variant: "warning", message: r.warning })
              if (themeCtx.has(name)) {
                themeCtx.set(name)
                const m = skinMode(name)
                if (m) themeCtx.setMode(m)
              }
              preferences.set("eikon", undefined)
              preferences.set("eikonPath", undefined)
              x.dispatch({ kind: "system", text: `skin → ${name}` })
            })
            .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
          return
        }
        case "resume":
          if (arg) { void x.switchSession(arg); return }
          x.goTo(TAB_SLASH.sessions.tab, TAB_SLASH.sessions.sub); return
        case "branch":
          branch(arg)
          return
        case "compress": void runCompress(arg); return
        case "undo":
          destructive(arg,
            { title: "Undo last turn?", body: "Pops the last user + assistant pair from the transcript. /redo in this session to restore.", yes: "undo" },
            () => {
              // Capture the tail before the server pops it so /redo can
              // replay. The snapshot is everything from the last user
              // message onward (user + assistant[+tool] run).
              const msgs = x.turnRef.current.messages
              const at = msgs.map(m => m.role).lastIndexOf("user")
              const tail = at >= 0 ? msgs.slice(at) : []
              x.session.undo()
                .then(() => {
                  if (tail.length) x.undone.current.push(tail)
                  return gw.request<{ messages: TranscriptMessage[] }>("session.history")
                })
                .then(r => x.dispatch({ kind: "load", messages: transcriptToMessages(r.messages ?? []) }))
                .catch((err: Error) => toast.show({ variant: "error", message: err.message }))
            })
          return
        case "redo": {
          const tail = x.undone.current.pop()
          const head = tail?.find(m => m.role === "user")
          if (!head) { toast.show({ variant: "info", message: "nothing to redo" }); return }
          x.sendRef.current(msgText(head))
          return
        }
        case "retry": {
          const last = [...x.turnRef.current.messages].reverse().find(m => m.role === "user")
          if (!last) { toast.show({ variant: "info", message: "nothing to retry" }); return }
          void x.rewind(last).then(ok => { if (ok) x.sendRef.current(msgText(last)) })
          return
        }
        case "model":
          if (!arg) { openModelPicker(dialog, gw); return }
          if (arg.trim() === "--refresh") { openModelPicker(dialog, gw, { refresh: true }); return }
          gw.request<{ value?: string; warning?: string }>("config.set",
            { key: "model", value: arg })
            .then(r => {
              if (r.warning) toast.show({ variant: "warning", message: r.warning })
              x.dispatch({ kind: "system", text: `model → ${r.value ?? arg}` })
            })
            .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
          return
        case "yolo":
          gw.request<{ value?: string; warning?: string; info?: SessionInfo }>("config.set", { key: "yolo" })
            .then(r => {
              if (r.info) {
                x.setInfo(r.info)
                x.setUsage(r.info.usage)
              } else {
                x.setInfo({ ...(x.info ?? {}), yolo: !x.info?.yolo })
              }
              toast.show({ variant: "success", message: `yolo ${r.value ?? "toggled"}` })
              if (r.warning) toast.show({ variant: "warning", message: r.warning })
            })
            .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
          return
        case "quit": quit(renderer, x.resumeId || x.sid, x.title, gw); return
        case "queue":
          if (!arg) { x.dispatch({ kind: "system", text: `${x.queueRef.current.length} queued` }); return }
          x.setQueue(q => [...q, arg]); return
        case "stash": {
          const comp = x.composer.current
          if (arg === "pop") {
            const e = Stash.pop()
            if (!e) return toast.show({ variant: "info", message: "stash empty" })
            comp?.set(e.text); x.setFocusRegion("input"); return
          }
          if (arg === "list") {
            const list = Stash.all()
            if (list.length === 0) return toast.show({ variant: "info", message: "stash empty" })
            dialog.replace(
              <DialogSelect
                title="Stashed prompts"
                filterable={list.length > 6}
                options={list.map(e => ({
                  title: trunc(e.text.replace(/\n/g, " ⏎ "), 50),
                  value: String(e.at),
                  hint: ago(e.at),
                }))}
                onSelect={o => {
                  const e = list.find(s => String(s.at) === o.value)
                  if (e) { Stash.drop(e.at); comp?.set(e.text); x.setFocusRegion("input") }
                  dialog.clear()
                }}
              />,
            )
            return
          }
          // Bare /stash with a non-empty buffer parks the text and
          // clears the composer for a quick follow-up /cmd; with an
          // arg, the arg itself is stashed.
          const text = arg || comp?.value().trim() || ""
          if (!text) return toast.show({ variant: "info", message: "nothing to stash — /stash list" })
          const n = Stash.push(text)
          if (!arg) comp?.set("")
          toast.show({ variant: "info", message: `stashed (${n}) — /stash pop to restore` })
          return
        }
        case "copy": {
          const all = x.turnRef.current.messages.filter(m => m.role === "assistant")
          const n = arg ? Math.min(Math.max(1, parseInt(arg, 10) || 0), all.length) : all.length
          const m = all[n - 1]
          if (!m) { toast.show({ variant: "info", message: "nothing to copy" }); return }
          const body = msgText(m)
          void clipCopy(body, toast, `copied ${body.length} chars`)
          return
        }
        case "paste": x.attachClipboard(); return
        case "image":
          if (!arg) { toast.show({ variant: "info", message: "usage: /image <path>" }); return }
          gw.request<ImageAttachResponse>("image.attach", { path: arg })
            .then(r => r.attached
              ? x.setAttachments(a => [...a, r])
              : toast.show({ variant: "warning", message: r.message ?? "attach failed" }))
            .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
          return
        case "background":
          if (!arg) { x.dispatch({ kind: "system", text: "/background <prompt>" }); return }
          gw.request<{ task_id?: string }>(
            "prompt.background",
            x.sid ? { session_id: x.sid, text: arg } : { text: arg },
          )
            .then(r => {
              if (!r.task_id) {
                toast.show({ variant: "error", message: "background start failed" })
                return
              }
              bg.register(r.task_id, arg)
              x.dispatch({ kind: "system", text: `bg ${r.task_id} started` })
            })
            .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
          return
        case "voice":
          x.voiceToggle((arg || "status").toLowerCase(), x.sid)
            .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
          return
        case "mouse": {
          const want = arg === "on" ? true : arg === "off" ? false : !renderer.useMouse
          renderer.useMouse = want
          preferences.set("mouse", want)
          toast.show({ variant: "info", message: `mouse ${want ? "on" : "off"}` })
          return
        }
        case "redraw": redraw(renderer); return
        case "browser": {
          // Route /browser through browser.manage RPC instead of slash.exec
          // so BROWSER_CDP_URL is set in the gateway process where AIAgent runs.
          // Mirrors ui-tui/src/app/slash/commands/ops.ts (issue #82).
          const parts = arg.trim().split(/\s+/)
          const sub = parts[0]?.toLowerCase() || "connect"
          const url = parts[1]
          if (!["connect", "disconnect", "status"].includes(sub)) {
            toast.show({ variant: "error", message: "usage: /browser [connect|disconnect|status] [url]" })
            return
          }
          const payload: Record<string, string> = { action: sub }
          if (sub === "connect" && url) payload.url = url
          gw.request<{ connected: boolean; url?: string; messages?: string[] }>("browser.manage", payload)
            .then(r => {
              for (const m of r.messages ?? []) {
                x.dispatch({ kind: "system", text: m })
              }
              if (r.connected) {
                x.dispatch({ kind: "system", text: `Browser connected${r.url ? ` → ${r.url}` : ""}` })
              } else if (sub === "disconnect") {
                x.dispatch({ kind: "system", text: "Browser disconnected" })
              } else if (sub === "status") {
                x.dispatch({ kind: "system", text: r.url ?? "No browser connected" })
              }
            })
            .catch((e: Error) => toast.show({ variant: "error", message: `browser: ${e.message}` }))
          return
        }
        case "setup":
          x.dispatch({ kind: "system",
            text: `/${c.name} is an Ink-TUI command and has no effect in herm` })
          return
        case "steer": {
          const fire = (text: string) =>
            gw.request<{ status?: string; text?: string }>("session.steer", { text })
              .then(r => toast.show(r.status === "queued"
                ? { variant: "success", message: "Queued — lands on next tool result" }
                : { variant: "info", message: "No turn running; send as a normal message" }))
              .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
          if (arg) { void fire(arg); return }
          openTextPrompt(dialog, { title: "Steer", label: "Note to inject on next tool result" })
            .then(text => { if (text) void fire(text) })
          return
        }
        case "reload-mcp": {
          // Reloading MCP invalidates prompt cache (tool schemas are baked into
          // the system prompt), so the next turn re-sends full input tokens.
          // `now`/`always` args skip our dialog for muscle-memory users.
          // Gateway-side `status:confirm_required` is still handled for
          // defense-in-depth — in practice we pre-empt it by passing confirm.
          const a = arg.trim().toLowerCase()
          const skip = a === "now" || a === "once" || a === "approve" || a === "yes" || a === "always"
          const fire = (always: boolean) =>
            gw.request<{ status?: string; message?: string }>("reload.mcp", { confirm: true, always })
              .then(r => r.status === "confirm_required"
                ? toast.show({ variant: "warning", message: r.message ?? "reload requires confirmation" })
                : toast.show({ variant: "success", message: always
                    ? "MCP servers reloaded · future /reload-mcp runs silently"
                    : "MCP servers reloaded" }))
              .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
          if (skip) { void fire(a === "always"); return }
          void openConfirm(dialog, {
            title: "Reload MCP servers?",
            body: "Rebuilds the MCP tool set. Invalidates the prompt cache, so the next message re-sends full input tokens.",
            yes: "reload", danger: true,
          }).then(ok => { if (ok) void fire(false) })
          return
        }
        case "reload":
          gw.request<{ updated?: number }>("reload.env", {})
            .then(r => {
              const n = Number(r.updated ?? 0)
              toast.show({ variant: "success",
                message: `Reloaded .env (${n} var${n === 1 ? "" : "s"} updated) · /new to apply` })
            })
            .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
          return
        case "reload-skills":
          gw.request<{ output: string; result: { added?: unknown[]; removed?: unknown[]; total?: number } }>(
            "skills.reload", {})
            .then(r => {
              x.dispatch({ kind: "system", text: r.output })
              const n = Number(r.result?.total ?? 0)
              toast.show({ variant: "success", message: `Skills reloaded (${n} available)` })
            })
            .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
          return
        case "save":
          gw.request<{ file: string }>("session.save")
            .then(r => toast.show({ variant: "success", message: `Saved → ${r.file}` }))
            .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
          return
      }
    }
    if (c.target !== "gateway") return
    if (!x.capabilities.canDispatchGatewayCommand) {
      const msg = x.capabilities.contractMessage
      if (!msg) return
      const text = `${msg} Blocked slash.exec.`
      x.dispatch({ kind: "system", text: `error: ${text}` })
      toast.show({ variant: "error", message: text })
      return
    }
    const jump = TAB_SLASH[c.name]
    if (jump !== undefined && !arg) { x.goTo(jump.tab, jump.sub); return }
    const full = `/${c.name}${arg ? " " + arg : ""}`
    // slash.exec owns the persistent HermesCLI subprocess; mid-stream it
    // races the agent turn. Enqueue as `/cmd arg` and let the drain path
    // (send → resolveSlash → slash) dispatch once idle.
    if (x.turnRef.current.streaming) { x.setQueue(q => [...q, full]); return }
    // slash.exec runs in a persistent HermesCLI subprocess; commands that
    // it rejects (skills, quick_commands, plugins, pending-input cmds)
    // fall through to command.dispatch, which returns a typed payload.
    // Upstream Ink does the same (see createSlashHandler.ts).
    x.dispatch({ kind: "user", text: full })
    gw.request<{ output?: string; warning?: string }>("slash.exec", { command: full })
      .then(res => {
        if (res?.warning) x.dispatch({ kind: "system", text: `⚠ ${res.warning}` })
        if (res?.output) x.dispatch({ kind: "system", text: res.output })
      })
      .catch(() => {
        type Dispatch = {
          type?: string; output?: string; target?: string
          message?: string; notice?: string; name?: string
        }
        gw.request<Dispatch>("command.dispatch", { name: c.name, arg })
          .then(d => {
            // `notice` is an optional system line attached to a `send`
            // payload — e.g. /goal set returns {type:send, notice:"⊙
            // Goal set (…)", message: goal} so the user sees the set
            // confirmation before the kickoff prompt fires.
            if (d.notice) x.dispatch({ kind: "system", text: d.notice })
            if (d.type === "exec" || d.type === "plugin")
              return x.dispatch({ kind: "system", text: d.output || "(no output)" })
            if (d.type === "alias" && d.target)
              return void x.sendRef.current(`/${d.target}${arg ? " " + arg : ""}`)
            if ((d.type === "skill" || d.type === "send") && d.message) {
              if (d.type === "skill")
                x.dispatch({ kind: "system", text: `⚡ loading skill: ${d.name ?? c.name}` })
              return void x.sendRef.current(d.message)
            }
            x.dispatch({ kind: "system", text: `/${c.name}: unknown` })
          })
          .catch((e: Error) => x.dispatch({ kind: "system", text: `error: ${e.message}` }))
      })
  }, [gw, dialog, toast, themeCtx, renderer, destructive, applyTitle, runCompress, branch])

  // Palette entries. Closures read through `ctx.current` so the effect
  // runs once (cmd is a stable context value) instead of re-registering
  // on every session.info tick.
  useEffect(() => cmd.register([
    { title: "Help", value: "help", action: "help.open", category: "General",
      onSelect: () => dialog.replace(<HelpDialog />) },
    { title: "Keybindings", value: "keys", description: "View & rebind shortcuts", category: "General",
      onSelect: () => openKeys(dialog) },
    { title: "Gateway Logs", value: "logs", description: "Show gateway stderr", category: "General",
      onSelect: () => openLogs(dialog) },
    { title: "Switch Theme", value: "theme", action: "theme.pick", category: "General",
      onSelect: () => openThemePicker(dialog, themeCtx) },
    { title: "Switch Model", value: "model", action: "model.pick", category: "General",
      onSelect: () => openModelPicker(dialog, gw) },
    { title: "Pick Avatar", value: "eikon", description: "Choose sidebar .eikon avatar", category: "General",
      onSelect: () => pickEikon() },
    { title: "Rollback", value: "rollback", description: "Browse & restore checkpoints", category: "Session",
      onSelect: () => openRollback(dialog, gw, toast) },
    { title: "History", value: "history", action: "session.timeline", category: "Session",
      onSelect: () => openHistory(dialog, gw) },
    { title: "Status", value: "status", action: "status.open", category: "Info",
      onSelect: () => openStatus(dialog, ctx.current.info, ctx.current.sid) },
    { title: "Usage", value: "usage", description: "Tokens · context · cost", category: "Info",
      onSelect: () => openUsage(dialog, gw) },
    { title: "Profile", value: "profile", description: "Active profile details", category: "Info",
      onSelect: () => openProfile(dialog) },
    { title: "New Session", value: "new-session", action: "session.new", category: "Session",
      onSelect: () => destructive("",
        { title: "Start a new session?", body: "Ends the current session and starts a fresh one. The existing session remains saved and resumable.", yes: "new session" },
        () => { void ctx.current.newSession() }) },
    { title: "Compress Session", value: "compress", action: "session.compress", category: "Session",
      onSelect: () => runCompress() },
    { title: "Undo Last Turn", value: "undo", description: "Pop last user+assistant pair", category: "Session",
      onSelect: () => run({ name: "undo", target: "local" } as SlashCommand) },
    { title: "Redo", value: "redo", action: "session.redo", category: "Session",
      onSelect: () => run({ name: "redo", target: "local" } as SlashCommand) },
    { title: "Branch Session", value: "branch", description: "Fork the current conversation", category: "Session",
      onSelect: () => branch() },
  ]), [cmd, dialog, themeCtx, gw, toast, destructive, pickEikon, runCompress, branch, run])

  return run
}
