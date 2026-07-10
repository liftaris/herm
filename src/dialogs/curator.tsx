// Curator control panel. Reads .curator_state + config.curator.*; the
// report pane shows the newest logs/curator/*/REPORT.md. Writes route
// through `shell.exec → hermes curator <verb>` so the CLI owns the
// state machine (see Agents.tsx / Kanban.tsx for the precedent).

import { useEffect, useState, useCallback, useRef } from "react"
import { useKeyboard } from "@opentui/react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTheme } from "../theme"
import type { DialogContext } from "../ui/dialog"
import { useDialog } from "../ui/dialog"
import { useGateway } from "../context/gateway"
import { useHome, home } from "../home"
import { useToast } from "../ui/toast"
import { readLatestCuratorReport, type CuratorReportInfo } from "../service/hermes-home"
import { KVLink } from "../components/ui/FileLink"
import { KVBlock } from "../ui/kv"
import { Spinner } from "../ui/spinner"
import { ago, until, dur, trunc } from "../ui/fmt"

const iso = (s: string | null | undefined): number | null => {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}

type Sh = { stdout: string; stderr: string; code: number }
type Verb = "run" | "pause" | "resume" | "list-archived" | "restore"

const parseList = (stdout: string): string[] =>
  stdout.split("\n").map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith("("))
const shq = (s: string) => /^[A-Za-z0-9._-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`

const CuratorDialog = () => {
  const { theme, syntaxStyle } = useTheme()
  const gw = useGateway()
  const toast = useToast()
  const dialog = useDialog()
  const state = useHome("curatorState")
  const cfg = useHome("config")?.curator
  const [report, setReport] = useState<CuratorReportInfo | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<Verb | null>(null)
  const busyRef = useRef<Verb | null>(null)
  const [archived, setArchived] = useState<string[]>([])
  const [mode, setMode] = useState<"report" | "archived">("report")
  const [sel, setSel] = useState(0)
  const sb = useRef<ScrollBoxRenderable | null>(null)

  useEffect(() => {
    readLatestCuratorReport()
      .then(r => { setReport(r); setLoaded(true) })
      .catch(() => setLoaded(true))
  }, [])

  const refreshArchived = useCallback(() => {
    gw.request<Sh>("shell.exec", { command: "hermes curator list-archived" })
      .then(r => {
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim())
        setArchived(parseList(r.stdout))
      })
      .catch(e => toast.show({ variant: "error", message: trunc(e instanceof Error ? e.message : String(e), 120) }))
  }, [gw, toast])

  useEffect(() => { refreshArchived() }, [refreshArchived])

  const sh = useCallback((verb: "run" | "pause" | "resume", ok: string) => {
    if (busyRef.current) return
    busyRef.current = verb
    setBusy(verb)
    gw.request<Sh>("shell.exec", { command: `hermes curator ${verb}` })
      .then(r => {
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim())
        toast.show({ variant: "success", message: ok })
        home.invalidate("curatorState")
      })
      .catch((e: Error) => toast.show({ variant: "error", message: trunc(e.message, 120) }))
      .finally(() => { busyRef.current = null; setBusy(null) })
  }, [gw, toast])

  const restore = useCallback((name: string) => {
    if (busyRef.current) return
    busyRef.current = "restore"
    setBusy("restore")
    gw.request<Sh>("shell.exec", { command: `hermes curator restore ${shq(name)}` })
      .then(r => {
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim())
        toast.show({ variant: "success", message: `Restored ${name}` })
        setArchived(prev => prev.filter(n => n !== name))
        setSel(s => Math.max(0, s - 1))
      })
      .catch((e: Error) => toast.show({ variant: "error", message: trunc(e.message, 120) }))
      .finally(() => { busyRef.current = null; setBusy(null) })
  }, [gw, toast])

  useKeyboard((key) => {
    if (mode === "archived") {
      if (key.name === "escape") { setMode("report"); return }
      if (key.raw === "a") { setMode("report"); return }
      if (key.name === "up") return setSel(s => Math.max(0, s - 1))
      if (key.name === "down") return setSel(s => Math.min(archived.length - 1, s + 1))
      if (key.name === "return") {
        const name = archived[sel]
        if (name) restore(name)
        return
      }
      return
    }
    if (key.name === "escape") return dialog.clear()
    if (key.raw === "r") return sh("run", "Curator run started (background)")
    if (key.raw === "p") return state?.paused
      ? sh("resume", "Curator resumed")
      : sh("pause", "Curator paused")
    if (key.raw === "a" && archived.length > 0) { setSel(0); setMode("archived") }
  })

  // Keep scroll cursor in view.
  useEffect(() => {
    if (mode === "archived") sb.current?.scrollChildIntoView(`arch-${sel}`)
  }, [sel, mode])

  const last = iso(state?.last_run_at ?? null)
  // Next-due is last_run_at + interval_hours. CLI additionally gates on
  // min_idle_hours, so this is "eligible from", not "will fire at".
  const due = last && cfg ? last + cfg.interval_hours * 3600 : null
  const status = cfg?.enabled === false ? "disabled"
    : state?.paused ? "paused"
    : "enabled"
  const tint = status === "enabled" ? theme.success
    : status === "paused" ? theme.warning : theme.textMuted

  return (
    <box flexDirection="column" width={120} height={34}>
      <box height={1} flexDirection="row">
        <text>
          <span fg={theme.primary}><strong>Skill Curator</strong></span>
          <span fg={tint}>{`  · ${status}`}</span>
        </text>
        {busy ? <box marginLeft={2}><Spinner color={theme.textMuted} label={busy} /></box> : null}
      </box>
      <box height={1}>
        <text fg={theme.textMuted}>
          {state
            ? `${state.run_count} run${state.run_count === 1 ? "" : "s"}${last ? " · last " + ago(last) : " · never"} · Esc to close`
            : "No curator state yet · Esc to close"}
        </text>
      </box>
      <box height={1} />

      <box flexDirection="row" flexGrow={1} gap={2}>
        <box flexDirection="column" width={40} height="100%" flexShrink={0}>
          <KVBlock rows={[
            ["Next run", status !== "enabled" ? `— (${status})`
              : due ? until(due) : "when idle"],
            ["Last run", last ? ago(last) : "never"],
            ["Duration", state?.last_run_duration_seconds
              ? dur(state.last_run_duration_seconds) : undefined],
            ["Archived", archived.length > 0 ? String(archived.length) : undefined],
          ]} />
          <box height={1} />
          <box height={1}><text fg={theme.textMuted}>Config  ·  edit in Config tab</text></box>
          <KVBlock rows={[
            ["Interval", cfg ? `${cfg.interval_hours}h` : "—"],
            ["Stale after", cfg ? `${cfg.stale_after_days}d` : "—"],
            ["Archive after", cfg ? `${cfg.archive_after_days}d` : "—"],
          ]} />
          <box height={1} />
          <box flexDirection="column">
            <box height={1}><text>
              <span fg={theme.accent}>r </span>
              <span fg={theme.text}>run now</span>
              <span fg={theme.textMuted}>  (background)</span>
            </text></box>
            <box height={1}><text>
              <span fg={theme.accent}>p </span>
              <span fg={theme.text}>{state?.paused ? "resume" : "pause"}</span>
            </text></box>
            {archived.length > 0 ? (
              <box height={1}><text>
                <span fg={theme.accent}>a </span>
                <span fg={theme.text}>archived skills</span>
                <span fg={theme.textMuted}>{`  (${archived.length})`}</span>
              </text></box>
            ) : null}
          </box>
          {state?.last_run_summary ? <>
            <box height={1} />
            <box height={1}><text fg={theme.textMuted}>Last run</text></box>
            <scrollbox scrollY flexGrow={1}>
              <markdown content={state.last_run_summary}
                fg={theme.markdownText} syntaxStyle={syntaxStyle} />
            </scrollbox>
          </> : null}
        </box>

        {mode === "archived" ? (
          <box flexDirection="column" flexGrow={1} height="100%" minWidth={0}>
            <box height={1}><text fg={theme.info}>
              <strong>{`▾ Archived skills (${archived.length})`}</strong>
            </text></box>
            <box height={1}><text fg={theme.textMuted}>
              {`↑↓ select  ·  Enter restore  ·  a/Esc back to report`}
            </text></box>
            <box height={1} />
            <scrollbox ref={sb} scrollY flexGrow={1} border borderColor={theme.border}
              paddingLeft={1} paddingRight={1}
              contentOptions={{ flexDirection: "column" }}>
              {archived.length === 0 ? (
                <text fg={theme.textMuted}>No archived skills.</text>
              ) : archived.map((name, i) => (
                <box key={name} id={`arch-${i}`} height={1}
                  backgroundColor={i === sel ? theme.backgroundElement : undefined}
                  onMouseMove={() => setSel(i)}
                  onMouseDown={() => restore(name)}>
                  <text fg={i === sel ? theme.text : theme.textMuted}>
                    {i === sel ? "▸ " : "  "}{name}
                  </text>
                </box>
              ))}
            </scrollbox>
          </box>
        ) : !loaded ? (
          <box height={1}><text fg={theme.textMuted}>loading report…</text></box>
        ) : report ? (
          <box flexDirection="column" flexGrow={1} height="100%" minWidth={0}>
            <box height={1}><text fg={theme.info}><strong>{`▾ Report · ${report.runId}`}</strong></text></box>
            <KVLink label="File" source={report.source} text={report.source.relative} />
            <box height={1} />
            <scrollbox scrollY flexGrow={1} border borderColor={theme.border}
              paddingLeft={1} paddingRight={1}>
              <box flexDirection="column" width="100%">
                <markdown content={report.content || "(empty)"}
                  fg={theme.markdownText} syntaxStyle={syntaxStyle} />
              </box>
            </scrollbox>
          </box>
        ) : (
          <box height={1}><text fg={theme.textMuted}>No runs yet — curator has not completed a cycle.</text></box>
        )}
      </box>
    </box>
  )
}

export const openCurator = (dialog: DialogContext) =>
  dialog.replace(<CuratorDialog />, undefined, { ownCancel: true })
