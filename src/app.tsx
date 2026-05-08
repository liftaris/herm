import { useRenderer, useTerminalDimensions } from "@opentui/react"
import { Profiler, useState, useEffect, useRef, useCallback, useMemo, useReducer } from "react"
import * as perf from "./utils/perf"
import * as spawnHistory from "./app/spawnHistory"
import { setBridge, enabled as controlEnabled } from "./utils/control"
import { hasInterp, interpolate } from "./utils/interpolate"
import { GatewayProvider, useGateway, useGatewayEvent, useGatewayRestart, type Gateway } from "./app/gateway"
import type { GatewayEvent, SessionInfo, TranscriptMessage, ImageAttachResponse } from "./utils/gateway-types"
import type { Message } from "./types/message"
import { text as msgText } from "./types/message"
import { CLOUD_MIN } from "./components/chat/ThoughtCloud"
import type { AvatarState } from "./components/avatar/states"
import { TabBar } from "./components/tabs/TabBar"
import { Sidebar } from "./components/sidebar/Sidebar"
import { Chat } from "./tabs/Chat"
import { Context } from "./tabs/Context"
import { Sessions } from "./tabs/Sessions"
import { Agents } from "./tabs/Agents"
import { Analytics } from "./tabs/Analytics"
import { Memory } from "./tabs/Memory"
import { Skills } from "./tabs/Skills"
import { Config } from "./tabs/Config"
import { Cron } from "./tabs/Cron"
import { Toolsets } from "./tabs/Toolsets"
import { Env } from "./tabs/Env"
import { Kanban } from "./tabs/Kanban"
import type { Usage } from "./types/message"
import { copySelection, copy as clipCopy } from "./utils/clipboard"
import { ThemeProvider, useTheme } from "./theme"
import { DialogProvider, useDialog } from "./ui/dialog"
import { ToastProvider, useToast } from "./ui/toast"
import { CommandProvider, useCommand } from "./ui/command"
import { KeysProvider } from "./keys"
import { HelpDialog } from "./dialogs/help"
import { openKeys } from "./dialogs/keys"
import { openLogs } from "./dialogs/logs"
import { openThemePicker } from "./dialogs/theme-picker"
import { openModelPicker } from "./dialogs/model-picker"
import { openEikonPicker } from "./dialogs/eikon-picker"
import { openTextPrompt } from "./dialogs/text-prompt"
import { openConfirm } from "./dialogs/confirm"
import { openRollback } from "./dialogs/rollback"
import { openHistory } from "./dialogs/history"
import { openStatus, openUsage, openProfile } from "./dialogs/info"
import { openChafa } from "./dialogs/chafa"
import { Splash } from "./ui/Splash"
import { lastReal } from "./utils/sessions-db"
import { readChangelog } from "./utils/hermes-home"
import { openAlert } from "./dialogs/alert"
import { openMessage } from "./dialogs/message"
import { parseEikon, type ParsedEikon } from "./components/avatar/eikon"
import { bundledEikonPath } from "./components/avatar/bundled"
import { pending as pendingPrompt, type PromptCardHandle } from "./components/chat/PromptCard"
import type { PromptWire } from "./components/chat/MessageItem"
import { resolve as resolveSlash, type SlashCommand } from "./commands/slash"
import { useSlashCommands } from "./app/useSlashCommands"
import { Composer, type ComposerHandle } from "./components/chat/Composer"
import * as preferences from "./utils/preferences"
import { turnReducer, initialTurn, transcriptToMessages } from "./app/turnReducer"
import { mapEvent } from "./app/gatewayEvents"
import { useSession } from "./app/useSession"
import { SkinProvider, deriveSkin, SKINS, type SkinState } from "./app/skin"
import { useAppKeys, redraw } from "./app/useAppKeys"
import { quit } from "./app/exit"
import { TABS, TAB_MAX, CHAT_TAB, TAB_SLASH } from "./app/tabs"
import { activeProfileName } from "./utils/hermes-profiles"
import { rehome } from "./home/rehome"
import { makeGoalHook } from "./app/goalHook"
import type { Launch } from "./app/launch"

type AppProps = { initialTheme?: string; gateway?: Gateway; launch?: Launch }

export const App = (props: AppProps) => (
  <ThemeProvider initial={props.initialTheme}>
    <GatewayProvider client={props.gateway}>
      <ToastProvider>
        <KeysProvider>
          <DialogProvider>
            <CommandProvider>
              <AppInner launch={props.launch ?? { mode: "new" }} />
            </CommandProvider>
          </DialogProvider>
        </KeysProvider>
      </ToastProvider>
    </GatewayProvider>
  </ThemeProvider>
)

const AppInner = ({ launch: launch0 }: { launch: Launch }) => {
  const gw = useGateway()
  const gwRestart = useGatewayRestart()
  const dialog = useDialog()
  const themeCtx = useTheme()
  const cmd = useCommand()
  const toast = useToast()
  const renderer = useRenderer()
  const session = useSession()
  const dims = useTerminalDimensions()
  const goalHook = useMemo(() => makeGoalHook(gw, dialog, toast), [gw, dialog, toast])

  const [turn, dispatch] = useReducer(turnReducer, initialTurn)
  const [ready, setReady] = useState(false)
  const [sid, setSid] = useState("")
  const sidRef = useRef(sid); sidRef.current = sid
  const [tab, setTab] = useState(CHAT_TAB)
  const [hideSidebar, setHideSidebar] = useState(false)
  const [usage, setUsage] = useState<Usage | undefined>(undefined)
  const [info, setInfo] = useState<SessionInfo | null>(null)
  const [title, setTitle] = useState("")
  const [focusRegion, setFocusRegion] = useState<"input" | "content">("input")
  const goToTab = useCallback((t: number) => {
    setTab(t)
    setFocusRegion(t === CHAT_TAB ? "input" : "content")
  }, [])
  const [status, setStatus] = useState("")
  const [eikon, setEikon] = useState<ParsedEikon | undefined>(undefined)
  const [queue, setQueue] = useState<string[]>([])
  // ── Splash ────────────────────────────────────────────────────────
  // Welcome-state chrome over an empty transcript. Composer stays live
  // underneath; first send dismisses. `/splash` re-summons mid-session
  // (Esc-dismissable in that case only).
  // Latched launch intent — the gateway.ready handler reads this. A
  // profile-switch overwrites it so the respawned gateway boots fresh
  // under the new HERMES_HOME instead of replaying the original argv.
  const launchRef = useRef<Launch>(launch0)
  const launch = launchRef.current
  const [splash, setSplash] = useState(launch.splash !== false)
  const [switching, setSwitching] = useState(false)
  const summoned = useRef(false)
  const [composing, setComposing] = useState(false)
  const splashLast = useMemo(
    () => launch.mode === "new" ? lastReal() : undefined,
    [launch.mode],
  )
  const news = useMemo(() => readChangelog()?.headline, [])
  const [attachments, setAttachments] = useState<ImageAttachResponse[]>([])
  const [cloudH, setCloudH] = useState(CLOUD_MIN)
  const [pick, setPick] = useState<Message | undefined>(undefined)
  const [skin, setSkin] = useState<SkinState>(() => deriveSkin(undefined))
  const inflight = useRef(false)
  // Client-side interrupt latch: flipped on Esc×2 before the gateway has
  // confirmed the stop. Stream-mutation events still in the stdio pipe
  // (already written by the agent thread before it saw the interrupt
  // flag) are dropped until the NEXT user send — not message.complete —
  // because run_agent's worker thread can keep emitting after the
  // monitor thread's InterruptedError has already ended the turn.
  const interrupted = useRef(false)
  const sessionStart = useRef(Date.now())
  const composer = useRef<ComposerHandle>(null)
  const promptRef = useRef<PromptCardHandle>(null)
  const { cmds } = useSlashCommands()
  // Live ref so send() (stable for queue-drain) reads the current catalog
  // without re-creating itself on every catalog refresh.
  const cmdsRef = useRef(cmds); cmdsRef.current = cmds

  // Transient error pulse — set on any reducer {kind:"error"} or
  // gateway exit; cleared when the avatar's play-once error clip
  // reaches hold (onAvatarHold below). `!ready` no longer maps to
  // error: cold boot is behind the splash, and a dead gateway already
  // emits "exit" → errorPulse via the listener below.
  const [errorPulse, setErrorPulse] = useState(false)

  const agentState: AvatarState = errorPulse
    ? "error"
    : turn.toolActive ? "working"
    : turn.streaming && turn.hasContent ? "speaking"
    : turn.streaming ? "thinking"
    : composing ? "listening"
    : "idle"

  const onAvatarHold = useCallback((s: AvatarState) => {
    if (s === "error") setErrorPulse(false)
  }, [])

  // ── Thought cloud ─────────────────────────────────────────────────
  // Auto-follows the "non-text" phase of a turn: open while the model is
  // reasoning or running tools (`streaming && !hasContent`), close once
  // text is flowing (`hasContent`) or the turn ends. A manual force
  // (avatar click, cloud click, message pin) overrides auto for the rest
  // of THAT turn; the override clears on the next turn's rising edge.
  // A pending inline prompt also suppresses the cloud — the overlay
  // would occlude the card the user needs to answer.
  const prompt = pendingPrompt(turn.messages)
  const cloudAuto = turn.streaming && !turn.hasContent && !prompt
  const [force, setForce] = useState<boolean | undefined>(undefined)
  const cloud = !prompt && (force ?? cloudAuto)
  const prevStream = useRef(turn.streaming)
  useEffect(() => {
    if (!prevStream.current && turn.streaming) { setForce(undefined); setPick(undefined) }
    prevStream.current = turn.streaming
  }, [turn.streaming])

  const onPick = useCallback((m?: Message) => {
    // Clicking the currently-pinned message toggles the cloud closed.
    setPick(p => {
      if (m && p && m.id === p.id) { setForce(false); return undefined }
      setForce(!!m)
      return m
    })
  }, [])
  // Avatar click and cloud body click: toggle. Closing clears any pin so
  // next open shows live state.
  const onAvatar = useCallback(() => {
    const next = !cloud
    if (!next) setPick(undefined)
    setForce(next)
  }, [cloud])
  const closeCloud = useCallback(() => { setForce(false); setPick(undefined) }, [])
  const onEnqueue = useCallback((t: string) => setQueue(q => [...q, t]), [])
  const onAttach = useCallback((r: ImageAttachResponse) => setAttachments(a => [...a, r]), [])

  // ── Session reset / lifecycle ─────────────────────────────────────
  const reset = useCallback(() => {
    interrupted.current = false
    dispatch({ kind: "reset" })
    setUsage(undefined)
    setReady(false)
    setStatus("")
    setTitle("")
    setAttachments([])
  }, [])

  const newSession = useCallback(async () => {
    reset()
    summoned.current = true
    setSplash(true)
    try { setSid(await session.create()); sessionStart.current = Date.now() }
    catch {}
  }, [reset, session])

  const switchSession = useCallback(async (target: string) => {
    reset()
    // Keep splash visible while the resume RPC lands so the user sees
    // the ornate frame instead of the empty-transcript welcome. summoned
    // suppresses the continue-prompt (we've already chosen a session);
    // switching drives the "Loading…" line on Splash.
    summoned.current = true
    setSplash(true)
    setSwitching(true)
    goToTab(CHAT_TAB)
    try {
      const res = await session.resume(target)
      setSid(res.id)
      sessionStart.current = Date.now()
      if (res.messages.length) dispatch({ kind: "load", messages: res.messages })
      setSplash(false)
      summoned.current = false
    } catch (err) {
      dispatch({ kind: "system", text: `Failed to resume: ${err instanceof Error ? err.message : String(err)}` })
      setSplash(false)
      summoned.current = false
    } finally {
      setSwitching(false)
    }
  }, [reset, session, goToTab])

  // ── Profile switch ────────────────────────────────────────────────
  // Rebind every HERMES_HOME reader, respawn the gateway subprocess
  // under the new env, and re-run the boot path. prefs.reload (inside
  // rehome) retints theme/eikon/keys via usePref; home.reset repaints
  // tabs. The session is NOT preserved — it belongs to the old
  // profile's state.db. Confirm step lives in the Agents tab.
  const switchProfile = useCallback((newHome: string, name: string) => {
    rehome(newHome)
    reset()
    gw.setSession("")
    setSid("")
    setInfo(null)
    setSkin(deriveSkin(undefined))
    // Fresh gateway boots behind the splash (same as cold launch); the
    // respawned process emits gateway.ready → session.info → onSend
    // dismisses. `summoned` suppresses the continue-prompt — the
    // outgoing profile's lastReal() is the wrong db.
    summoned.current = true
    setSplash(true)
    launchRef.current = { mode: "new", splash: true }
    toast.show({ variant: "info", message: `Switching to '${name}'…` })
    goToTab(CHAT_TAB)
    gwRestart()
  }, [reset, goToTab, gwRestart, toast, gw])

  // Compress wrapper — toasts on start, dispatches a transcript system
  // message carrying the headline + token line from the gateway's
  // summary payload on completion. Upstream emits intermediate
  // status.update{kind:"compressing"} events that already feed the
  // status bar via gatewayEvents.ts.
  const runCompress = useCallback(async () => {
    toast.show({ variant: "info", message: "Compressing session…" })
    const r = await session.compress()
    if (!r || !r.summary) return
    const s = r.summary
    if (s.noop) {
      toast.show({ variant: "info",
        message: s.headline ?? `No changes · ~${r.before_tokens ?? 0} tokens` })
      return
    }
    const lines = [s.headline, s.token_line, s.note].filter(Boolean).join("\n")
    if (lines) dispatch({ kind: "system", text: lines })
    toast.show({ variant: "success",
      message: s.headline ?? `Compressed ${r.before_messages ?? 0}→${r.after_messages ?? 0} messages` })
  }, [session, toast, dispatch])

  // ── Eikon avatar ──────────────────────────────────────────────────
  const loadEikon = useCallback((path: string) => {
    Bun.file(path).text()
      .then(t => setEikon(parseEikon(t)))
      .catch(() => {})
  }, [])

  // Precedence: user pref → bundled eikon matching active skin → baked-in
  // default (nous-girl via STATE_FRAMES). Skin match never writes the
  // pref, so a later manual pick sticks across skin changes.
  const eikonPath = preferences.usePref("eikonPath")
  useEffect(() => {
    const p = eikonPath || bundledEikonPath(skin.skin?.name)
    if (p) loadEikon(p); else setEikon(undefined)
  }, [eikonPath, skin.skin?.name, loadEikon])

  const pickEikon = useCallback(() => {
    openEikonPicker(dialog, (path) => preferences.set("eikonPath", path))
  }, [dialog])

  // ── Title ─────────────────────────────────────────────────────────
  const applyTitle = useCallback((t: string) => {
    gw.request<{ title: string }>("session.title", { title: t })
      .then(r => { setTitle(r.title); dispatch({ kind: "system", text: `Title: ${r.title}` }) })
      .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
  }, [gw, toast])

  const editTitle = useCallback(() => {
    openTextPrompt(dialog, { title: "Session Title", initial: title })
      .then(v => { if (v) applyTitle(v) })
  }, [dialog, title, applyTitle])

  // ── Message actions ───────────────────────────────────────────────
  // turnsFrom counts user turns at-or-after m — each session.undo pops
  // one user+assistant pair server-side.
  const turnsFrom = (m: Message) => {
    const at = turn.messages.findIndex(x => x.id === m.id)
    return at < 0 ? 0 : turn.messages.slice(at).filter(x => x.role === "user").length
  }

  const rewind = useCallback(async (m: Message) => {
    if (turn.streaming) return
    const n = turnsFrom(m)
    if (n === 0) return
    const text = m.parts.filter(p => p.type === "text").map(p => p.content).join("")
    for (let i = 0; i < n; i++) await gw.request("session.undo").catch(() => {})
    const r = await gw.request<{ messages: TranscriptMessage[] }>("session.history").catch(() => null)
    const at = turn.messages.findIndex(x => x.id === m.id)
    dispatch({ kind: "load", messages: r ? transcriptToMessages(r.messages ?? []) : turn.messages.slice(0, at) })
    composer.current?.set(text)
    setFocusRegion("input")
  }, [turn.streaming, turn.messages, gw])

  // Non-destructive: session.branch clones full history into a new
  // gateway session; undo N turns *in that session* to land at m;
  // then switch. Original session is untouched.
  const fork = useCallback(async (m: Message) => {
    if (turn.streaming) return
    const n = turnsFrom(m)
    const text = m.parts.filter(p => p.type === "text").map(p => p.content).join("")
    const res = await gw.request<{ session_id: string; title?: string }>("session.branch", {})
      .catch((e: Error) => { toast.show({ variant: "error", message: `branch failed: ${e.message}` }); return null })
    if (!res?.session_id) return
    for (let i = 0; i < n; i++)
      await gw.request("session.undo", { session_id: res.session_id }).catch(() => {})
    await switchSession(res.session_id)
    composer.current?.set(text)
    setFocusRegion("input")
    toast.show({ variant: "success", message: `forked → ${res.title ?? res.session_id}` })
  }, [turn.streaming, turn.messages, gw, toast, switchSession])

  const msgMenu = useCallback((m: Message) => {
    if (turn.streaming) return
    openMessage(dialog, m, { rewind, fork })
  }, [turn.streaming, dialog, rewind, fork])

  // ── Attachments ───────────────────────────────────────────────────
  // Gateway owns the canonical list (session["attached_images"]); chips
  // are a client-side mirror. prompt.submit drains server-side, so clear
  // here too. No image.detach RPC yet — chips are display-only.
  const attachClipboard = useCallback(() => {
    gw.request<ImageAttachResponse>("clipboard.paste")
      .then(r => r.attached
        ? setAttachments(a => [...a, r])
        : toast.show({ variant: "info", message: r.message ?? "No image in clipboard" }))
      .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
  }, [gw, toast])

  // ── Slash dispatch ────────────────────────────────────────────────
  // `slash` and `send` reference each other (skill/alias dispatch needs
  // to submit a turn; typed `/cmd` in send() resolves via slash). The
  // cycle is broken with a forward ref — same shape as upstream Ink's
  // slashRef/submitRef pair.
  const sendRef = useRef<(raw: string) => void>(() => {})
  const slash = useCallback((c: SlashCommand, arg = "") => {
    if (c.target === "local") {
      switch (c.name) {
        case "clear": dispatch({ kind: "reset" }); return
        case "new": newSession(); return
        case "theme": openThemePicker(dialog, themeCtx); return
        case "help": dialog.replace(<HelpDialog />); return
        case "keys": openKeys(dialog); return
        case "logs": openLogs(dialog); return
        case "eikon": pickEikon(); return
        case "title": arg ? applyTitle(arg) : editTitle(); return
        case "rollback": openRollback(dialog, gw, toast); return
        case "history": openHistory(dialog, gw); return
        case "status": openStatus(dialog, info, sid); return
        case "usage": openUsage(dialog, gw); return
        case "profile": openProfile(dialog); return
        case "chafa":
          if (!arg.trim()) { toast.show({ variant: "info", message: "usage: /chafa <path>" }); return }
          openChafa(dialog, arg.trim())
          return
        case "splash": summoned.current = true; setSplash(true); return
        case "skin": {
          const name = arg.trim()
          if (!name) {
            dispatch({ kind: "system",
              text: `skin: ${skin.skin?.name ?? "—"}\n  ${SKINS.join("  ")}` })
            return
          }
          if (!(SKINS as readonly string[]).includes(name)) {
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
              if (themeCtx.has(name)) themeCtx.set(name)
              preferences.set("eikonPath", undefined)
              dispatch({ kind: "system", text: `skin → ${name}` })
            })
            .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
          return
        }
        case "goal": {
          goalHook.cmd(arg, sid)
            .then(r => {
              dispatch({ kind: "system", text: r.line })
              // CLI's _handle_goal_command kicks the loop off via
              // _pending_input.put(goal); the slash-worker's CLI has
              // no input loop, so herm does the equivalent: submit
              // the goal text as the first prompt. tui_gateway's
              // post-turn Ralph hook takes over from there.
              if (r.kick) void sendRef.current(r.kick)
            })
            .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
          return
        }
        // ── parity: session-mutating (slash-worker can't service these) ──
        case "resume":
          if (arg) { void switchSession(arg); return }
          goToTab(TAB_SLASH.sessions); return
        case "branch":
          session.branch(arg || undefined).then(id => id
            ? void switchSession(id)
            : toast.show({ variant: "error", message: "branch failed" }))
          return
        case "compress": void runCompress(); return
        case "undo":
          session.undo().then(() =>
            gw.request<{ messages: TranscriptMessage[] }>("session.history")
              .then(r => dispatch({ kind: "load", messages: transcriptToMessages(r.messages ?? []) }))
              .catch(() => {}))
          return
        case "retry": {
          const last = [...turn.messages].reverse().find(m => m.role === "user")
          if (!last) { toast.show({ variant: "info", message: "nothing to retry" }); return }
          void rewind(last).then(() => sendRef.current(msgText(last)))
          return
        }
        case "model":
          if (!arg) { openModelPicker(dialog, gw); return }
          gw.request<{ value?: string; warning?: string }>("config.set",
            { key: "model", value: arg })
            .then(r => {
              if (r.warning) toast.show({ variant: "warning", message: r.warning })
              dispatch({ kind: "system", text: `model → ${r.value ?? arg}` })
            })
            .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
          return
        case "quit": quit(renderer, sid, title); return
        case "queue":
          if (!arg) { dispatch({ kind: "system", text: `${queue.length} queued` }); return }
          setQueue(q => [...q, arg]); return
        case "copy": {
          const all = turn.messages.filter(m => m.role === "assistant")
          const n = arg ? Math.min(Math.max(1, parseInt(arg, 10) || 0), all.length) : all.length
          const m = all[n - 1]
          if (!m) { toast.show({ variant: "info", message: "nothing to copy" }); return }
          const body = msgText(m)
          void clipCopy(body)
          toast.show({ variant: "success", message: `copied ${body.length} chars` })
          return
        }
        case "paste": attachClipboard(); return
        case "image":
          if (!arg) { toast.show({ variant: "info", message: "usage: /image <path>" }); return }
          gw.request<ImageAttachResponse>("image.attach", { path: arg })
            .then(r => r.attached
              ? setAttachments(a => [...a, r])
              : toast.show({ variant: "warning", message: r.message ?? "attach failed" }))
            .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
          return
        case "background":
          if (!arg) { toast.show({ variant: "info", message: "usage: /background <prompt>" }); return }
          gw.request<{ task_id?: string }>("prompt.background", { text: arg })
            .then(r => toast.show(r.task_id
              ? { variant: "success", message: `background ${r.task_id} started` }
              : { variant: "error", message: "background start failed" }))
            .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
          return
        case "voice":
          gw.request<{ enabled?: boolean; tts?: boolean }>("voice.toggle",
            { action: (arg || "status").toLowerCase() })
            .then(r => dispatch({ kind: "system",
              text: `voice ${r.enabled ? "on" : "off"}${r.tts ? " · tts on" : ""}` }))
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
        case "compact":
        case "setup":
          dispatch({ kind: "system",
            text: `/${c.name} is an Ink-TUI command and has no effect in herm` })
          return
        case "steer": {
          const fire = (text: string) =>
            gw.request<{ accepted: boolean }>("session.steer", { text })
              .then(r => toast.show(r.accepted
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
        case "save":
          gw.request<{ file: string }>("session.save")
            .then(r => toast.show({ variant: "success", message: `Saved → ${r.file}` }))
            .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
          return
      }
    }
    if (c.target !== "gateway" || !ready) return
    const jump = TAB_SLASH[c.name]
    if (jump !== undefined && !arg) { goToTab(jump); return }
    const full = `/${c.name}${arg ? " " + arg : ""}`
    // slash.exec owns the persistent HermesCLI subprocess; mid-stream it
    // races the agent turn. Enqueue as `/cmd arg` and let the drain path
    // (send → resolveSlash → slash) dispatch once idle.
    if (turn.streaming) { setQueue(q => [...q, full]); return }
    // slash.exec runs in a persistent HermesCLI subprocess; commands that
    // it rejects (skills, quick_commands, plugins, pending-input cmds)
    // fall through to command.dispatch, which returns a typed payload.
    // Upstream Ink does the same (see createSlashHandler.ts).
    dispatch({ kind: "user", text: full })
    gw.request<{ output?: string; warning?: string }>("slash.exec", { command: full })
      .then(res => {
        if (res?.warning) dispatch({ kind: "system", text: `⚠ ${res.warning}` })
        if (res?.output) dispatch({ kind: "system", text: res.output })
      })
      .catch(() => {
        type Dispatch = { type?: string; output?: string; target?: string; message?: string; name?: string }
        gw.request<Dispatch>("command.dispatch", { name: c.name, arg })
          .then(d => {
            if (d.type === "exec" || d.type === "plugin")
              return dispatch({ kind: "system", text: d.output || "(no output)" })
            if (d.type === "alias" && d.target)
              return void sendRef.current(`/${d.target}${arg ? " " + arg : ""}`)
            if ((d.type === "skill" || d.type === "send") && d.message) {
              if (d.type === "skill")
                dispatch({ kind: "system", text: `⚡ loading skill: ${d.name ?? c.name}` })
              return void sendRef.current(d.message)
            }
            dispatch({ kind: "system", text: `/${c.name}: unknown` })
          })
          .catch((e: Error) => dispatch({ kind: "system", text: `error: ${e.message}` }))
      })
  }, [ready, turn.streaming, turn.messages, dialog, themeCtx, newSession, gw, pickEikon, editTitle,
      applyTitle, toast, info, sid, title, switchSession, session, runCompress, rewind, renderer,
      attachClipboard, goToTab, queue.length, goalHook, skin])

  // ── Send ──────────────────────────────────────────────────────────
  const send = useCallback(async (raw: string) => {
    // Slash-shaped input resolves against the merged catalog: exact
    // name/alias wins, else unique prefix. This covers the "typed with
    // arg" path the popover can't — e.g. `/mod gpt-4`, `/q follow-up`.
    // Unknown `/xxx` falls through to prompt.submit verbatim (lets the
    // agent interpret paths like `/etc/hosts`).
    const m = raw.match(/^\/(\S+)(?:\s+([\s\S]*))?$/)
    if (m) {
      const [, name, arg = ""] = m
      const r = resolveSlash(cmdsRef.current, name)
      if ("hit" in r) return slash(r.hit, arg.trim())
      if ("ambiguous" in r) {
        const head = r.ambiguous.slice(0, 6).join(", ")
        return dispatch({
          kind: "system",
          text: `ambiguous: /${name} → ${head}${r.ambiguous.length > 6 ? ", …" : ""}`,
        })
      }
    }
    // {!cmd} spans resolve via shell.exec before submit so the
    // transcript shows what was actually sent. The await is short
    // (gateway-side 30s cap); status line signals the wait.
    let text = raw
    if (hasInterp(raw)) {
      setStatus("interpolating…")
      text = await interpolate(gw, raw)
      setStatus("")
    }
    interrupted.current = false
    // Echo attachments into the user's transcript message as MEDIA: lines
    // so ChafaImage renders them inline. Gateway also tracks them in
    // session["attached_images"] for the agent-side enrichment — these
    // are display only, the path in the chip is what the agent sees.
    // The wire stays `text` (not `withMedia`) so the gateway's text-mode
    // image routing doesn't collide with an explicit MEDIA: duplicate
    // and so the persisted user row doesn't drag the analysis block
    // into view on resume. Parity with Ink: live preview is ours, the
    // resume view falls back to whatever upstream persisted.
    const withMedia = attachments.length
      ? [...attachments.flatMap(a => a.path ? [`MEDIA:${a.path}`] : []), text].filter(Boolean).join("\n")
      : text
    dispatch({ kind: "user", text: withMedia })
    setAttachments([])
    gw.request("prompt.submit", { text }).catch(() => { inflight.current = false })
    setTab(CHAT_TAB)
  }, [gw, slash, attachments])
  sendRef.current = send

  // Dismiss-on-send wrapper. Also the single gate for the splash's
  // "continue last?" prompt: empty-Enter while it's visible resumes
  // lastReal via the existing switchSession path.
  const onSend = useCallback((raw: string) => { setSplash(false); return send(raw) }, [send])
  const onEmptyEnter = useCallback(() => {
    if (!splash || summoned.current || !splashLast || composing) return false
    setSplash(false)
    void switchSession(splashLast.id)
    return true
  }, [splash, splashLast, composing, switchSession])

  // ── Queue drain ───────────────────────────────────────────────────
  // Purely client-side: prompts typed while streaming accumulate in
  // `queue`; on idle the head auto-submits. turnReducer doesn't flip
  // `streaming` until the gateway emits message.start (async), so a
  // naive effect would fire repeatedly and drain the whole queue in
  // one tick. `inflight` bridges the dispatch→message.start gap.
  useEffect(() => { if (turn.streaming) inflight.current = false }, [turn.streaming])
  useEffect(() => {
    if (turn.streaming || inflight.current || !ready || queue.length === 0) return
    const [head, ...rest] = queue
    inflight.current = true
    setQueue(rest)
    send(head)
  }, [turn.streaming, ready, queue, send])

  const dequeue = useCallback((i: number) => {
    const item = queue[i]
    if (item === undefined) return
    setQueue(q => q.filter((_, j) => j !== i))
    composer.current?.set(item)
    setFocusRegion("input")
  }, [queue])

  // ── Copy last assistant ───────────────────────────────────────────
  const copyLast = useCallback(() => {
    for (let i = turn.messages.length - 1; i >= 0; i--) {
      const m = turn.messages[i]
      if (m.role !== "assistant") continue
      const text = m.parts.filter(p => p.type === "text").map(p => p.content).join("")
      if (!text) continue
      process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`)
      return true
    }
    return false
  }, [turn.messages])

  // ── Gateway events ────────────────────────────────────────────────
  // Delta batching: streamed text/reasoning chunks are accumulated in
  // a ref and flushed at most once per 16ms. Every delta otherwise
  // triggers an O(messages) array spread + O(content) string concat +
  // full markdown re-parse of the streaming block. Any non-delta
  // action flushes synchronously first so part ordering is preserved.
  const deltas = useRef({ text: "", think: "", timer: null as ReturnType<typeof setTimeout> | null })

  const flush = useCallback(() => {
    const d = deltas.current
    if (d.timer) { clearTimeout(d.timer); d.timer = null }
    if (d.think) { dispatch({ kind: "thinking", text: d.think, final: false }); d.think = "" }
    if (d.text) { dispatch({ kind: "message.delta", chunk: d.text }); d.text = "" }
  }, [])

  // Events that mutate the in-progress assistant turn. Everything else
  // (system messages, session.info, toasts, completion, side channels)
  // is orthogonal to the stream and must pass the interrupt gate.
  const STREAM_EVENTS = useRef(new Set<GatewayEvent["type"]>([
    "message.start",
    "message.delta", "reasoning.delta", "reasoning.available", "thinking.delta",
    "tool.start", "tool.progress", "tool.generating",
  ])).current

  const handle = useCallback((ev: GatewayEvent) => {
    // The agent's stream-retry loop (run_agent._call) classifies the
    // force-closed httpx socket from an interrupt as a transient drop
    // and emits "Reconnecting…" lifecycle status before the top-of-loop
    // interrupt guard catches it. Drain those (and any ghost stream
    // events from the clear_interrupt race) until the next user send.
    if (interrupted.current) {
      if (STREAM_EVENTS.has(ev.type)) return
      if (ev.type === "status.update" && ev.payload?.kind === "lifecycle") return
    }
    const action = mapEvent(ev, {
      onReady: () => {
        session.boot(launchRef.current).then((r) => {
          setSid(r.id)
          sessionStart.current = Date.now()
          if (r.messages.length) dispatch({ kind: "load", messages: r.messages })
          if (r.note) toast.show({ variant: "info", message: r.note })
        })
      },
      onSessionInfo: (si) => {
        setInfo(si)
        setReady(true)
        if (si.session_id) setSid(si.session_id)
        const bad = (si.mcp_servers ?? []).filter(s => !s.connected)
        if (bad.length) dispatch({
          kind: "system",
          text: `MCP: ${bad.length} server(s) failed to connect — ${bad.map(s => s.name + (s.error ? ` (${s.error})` : "")).join(", ")}`,
        })
        gw.request<{ title: string; session_key?: string }>("session.title").then(r => {
          setTitle(r.title ?? "")
          if (r.session_key) preferences.set("lastSessionId", r.session_key)
        }).catch(() => {})
      },
      onUsage: (u) => setUsage(u),
      onTurnComplete: () => {
        setStatus("")
        spawnHistory.flush(gw, sidRef.current)
        goalHook.check(sidRef.current)
      },
      onBackground: (tid, text) => {
        const head = text.split("\n")[0].slice(0, 80)
        dispatch({ kind: "system", text: `◷ background task ${tid} complete — ${head}` })
        toast.show({
          variant: "info", title: "Background task complete", message: head,
          duration: 8000,
          action: { label: "view", run: () => openAlert(dialog, `Background task ${tid}`, text) },
        })
      },
      onBtw: (text) => {
        const head = text.split("\n")[0].slice(0, 80)
        dispatch({ kind: "system", text: `◈ btw — ${head}` })
        toast.show({
          variant: "info", title: "btw", message: head, duration: 8000,
          action: { label: "view", run: () => openAlert(dialog, "btw", text) },
        })
      },
      onStatus: (text) => setStatus(text),
      onSkin: (s) => setSkin(deriveSkin(s)),
    })
    if (!action) return
    const d = deltas.current
    if (action.kind === "message.delta") {
      if (d.think) flush()
      d.text += action.chunk
      d.timer ??= setTimeout(flush, 16)
      return
    }
    if (action.kind === "thinking" && !action.final) {
      if (d.text) flush()
      d.think += action.text
      d.timer ??= setTimeout(flush, 16)
      return
    }
    flush()
    if (action.kind === "error") setErrorPulse(true)
    dispatch(action)
  }, [session, dialog, toast, gw, flush, goalHook])

  useGatewayEvent(handle)

  // ── Command palette ───────────────────────────────────────────────
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
      onSelect: () => openStatus(dialog, info, sid) },
    { title: "Usage", value: "usage", description: "Tokens · context · cost", category: "Info",
      onSelect: () => openUsage(dialog, gw) },
    { title: "Profile", value: "profile", description: "Active profile details", category: "Info",
      onSelect: () => openProfile(dialog) },
    { title: "New Session", value: "new-session", action: "session.new", category: "Session",
      onSelect: () => newSession() },
    { title: "Compress Session", value: "compress", action: "session.compress", category: "Session",
      onSelect: () => runCompress() },
    { title: "Undo Last Turn", value: "undo", description: "Pop last user+assistant pair", category: "Session",
      onSelect: () => session.undo() },
    { title: "Branch Session", value: "branch", description: "Fork the current conversation", category: "Session",
      onSelect: () => session.branch() },
  ]), [cmd, dialog, themeCtx, session, gw, toast, newSession, pickEikon, info, sid, runCompress])

  const doInterrupt = useCallback(() => {
    interrupted.current = true
    // Drop any 16ms-batched deltas that haven't hit the reducer yet —
    // flushing them would append post-interrupt text.
    const d = deltas.current
    if (d.timer) { clearTimeout(d.timer); d.timer = null }
    d.text = ""; d.think = ""
    session.interrupt()
  }, [session])

  // ── Keyboard ──────────────────────────────────────────────────────
  useAppKeys({
    tab, tabMax: TAB_MAX, chatTab: CHAT_TAB, setTab, focusRegion, setFocusRegion,
    streaming: turn.streaming,
    dialogOpen: dialog.open,
    composer,
    // Route keys to the pending inline prompt card before anything
    // else. Card returns true when the key was consumed; the shell
    // then stopPropagates so the composer textarea doesn't see it.
    // promptRef is null when no card is pending (Outcome rows don't
    // take the ref), so feed short-circuits.
    onPromptKey: (k) => promptRef.current?.feed(k) ?? false,
    onEscape: () => {
      if (!splash || !summoned.current) return false
      setSplash(false); summoned.current = false
      return true
    },
    onInterrupt: doInterrupt,
    // queue.flush is just an interrupt — the drain effect auto-fires
    // the head once turn.streaming flips false.
    queued: queue.length,
    onFlushQueue: doInterrupt,
    onQuit: () => quit(renderer, sid, title),
    onInterruptNotice: () => dispatch({ kind: "interrupt.notice", text: "Press Escape again to interrupt" }),
    onCopyLast: () => { copyLast() },
    onAttachClipboard: attachClipboard,
    // Client-side drop only. Gateway's session["attached_images"] still
    // has the orphaned path until the next prompt.submit drains it, or
    // session reset clears it — the side channel is write-only from here.
    onDetachLast: () => {
      if (attachments.length === 0) return false
      setAttachments(a => a.slice(0, -1))
      return true
    },
    onNotice: (text) => dispatch({ kind: "system", text }),
    onToggleSidebar: () => setHideSidebar(v => !v),
  })

  // ── Control bridge ────────────────────────────────────────────────
  const state = useRef({ tab, ready, streaming: turn.streaming, messages: turn.messages, sid, focusRegion })
  state.current = { tab, ready, streaming: turn.streaming, messages: turn.messages, sid, focusRegion }
  useEffect(() => {
    if (!controlEnabled) return
    setBridge({
      tab: () => state.current.tab,
      setTab,
      send: (msg: string) => {
        if (!state.current.ready || state.current.streaming) return
        dispatch({ kind: "user", text: msg })
        gw.request("prompt.submit", { text: msg }).catch(() => {})
        setTab(CHAT_TAB)
      },
      ready: () => state.current.ready,
      streaming: () => state.current.streaming,
      messages: () => state.current.messages.length,
      session: () => state.current.sid,
      input: () => composer.current?.value() ?? "",
      setInput: (v: string) => composer.current?.set(v),
      focusRegion: () => state.current.focusRegion,
      setFocusRegion,
      renderer: () => renderer,
      logs: (n?: number) => gw.tail(n),
    })
  }, [gw, renderer])

  const contentFocused = focusRegion === "content" && !turn.streaming

  // ── Inline prompt wiring ──────────────────────────────────────────
  // At most one pending prompt (gateway blocks on the answer). The
  // card mounts inside MessageList; key routing and composer-defocus
  // live here because the shell owns both. `prompt` is computed above
  // (before `cloud`) because a pending prompt also suppresses the
  // ThoughtCloud overlay.
  const promptAnswer = useCallback((id: string, label: string, ok: boolean) =>
    dispatch({ kind: "prompt.answered", id, label, ok }), [])
  const promptWire: PromptWire = useMemo(
    () => ({ ref: promptRef, onAnswer: promptAnswer }), [promptAnswer])
  // Snap to Chat when a prompt arrives so it isn't answered blind.
  useEffect(() => { if (prompt && tab !== CHAT_TAB) setTab(CHAT_TAB) }, [prompt?.id])

  const content = () => {
    const inner = (() => {
      switch (tab) {
        case 0: return <Chat messages={turn.messages} streaming={turn.streaming}
                             prompt={promptWire}
                             cloud={cloud} cloudH={cloudH} pick={pick}
                             onResize={setCloudH} onPick={onPick} onClose={closeCloud} onRewind={msgMenu} />
        case 1: return <Context description={TABS[tab].description} messages={turn.messages}
                               sessionStart={sessionStart.current} info={info ?? undefined}
                               focused={contentFocused} />
        case 2: return <Sessions onSwitch={switchSession} currentId={sid} focused={contentFocused} />
        case 3: return <Agents focused={contentFocused} sessionId={sid} onSwitchProfile={switchProfile} />
        case 4: return <Analytics focused={contentFocused} />
        case 5: return <Skills focused={contentFocused} />
        case 6: return <Cron focused={contentFocused} />
        case 7: return <Toolsets focused={contentFocused} />
        case 8: return <Config focused={contentFocused} />
        case 9: return <Env focused={contentFocused} />
        case 10: return <Memory focused={contentFocused} />
        case 11: return <Kanban focused={contentFocused} />
        default: return null
      }
    })()
    const name = TABS[tab]?.name ?? "unknown"
    return <Profiler id={`tab:${name}`} onRender={perf.onRender}>{inner}</Profiler>
  }

  const theme = themeCtx.theme
  const onMouseUp = useCallback(() => copySelection(renderer), [renderer])
  // Composer defocuses while any prompt is pending. Approval/clarify
  // list-mode don't need input, and this guarantees the textarea's
  // `focused` prop flips false→true on answer so OpenTUI refocuses it
  // (a card's own <input focused> would otherwise leave it blurred).
  // Keys still reach the card via onPromptKey on the global bus.
  const inputFocused = focusRegion === "input" && !prompt

  return (
    <Profiler id="shell" onRender={perf.onRender}>
     <SkinProvider value={skin}>
      <box width="100%" height="100%" flexDirection="column"
           backgroundColor={theme.background} onMouseUp={onMouseUp}>
        <TabBar tabs={TABS} activeTab={tab} onTabChange={goToTab} />
        <box flexGrow={1} flexDirection="row">
          <box flexGrow={1} flexDirection="column">
            <box flexGrow={1} position="relative">
              {content()}
              {splash && tab === CHAT_TAB ? (
                <Splash
                  info={info ? {
                    agentVersion: info.version,
                    behind: info.update_behind,
                    model: info.model,
                  } : undefined}
                  last={summoned.current ? undefined : splashLast
                    ? { id: splashLast.id, title: splashLast.title } : undefined}
                  composing={composing}
                  news={news}
                  loading={switching || !info}
                />
              ) : null}
            </box>
            <box flexShrink={0} zIndex={1}>
              <Composer
                ref={composer}
                focused={inputFocused} ready={ready} streaming={turn.streaming}
                status={status}
                queue={queue}
                attachments={attachments}
                cmds={cmds}
                onSend={onSend} onSlash={slash}
                onAttach={onAttach}
                onEnqueue={onEnqueue}
                onDequeue={dequeue}
                onDirty={setComposing}
                onEmptyEnter={onEmptyEnter}
              />
            </box>
          </box>
          {dims.width >= (tab === CHAT_TAB ? 120 : 140) && !hideSidebar ? (
            <Profiler id="sidebar" onRender={perf.onRender}>
              <Sidebar agentState={agentState} info={info} usage={usage} eikon={eikon} profile={activeProfileName()}
                       title={title}
                       cloud={tab === 0 && cloud} pulse={turn.streaming}
                       onAvatar={onAvatar} onAvatarHold={onAvatarHold} />
            </Profiler>
          ) : null}
        </box>
      </box>
     </SkinProvider>
    </Profiler>
  )
}
