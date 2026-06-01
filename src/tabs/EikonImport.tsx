// Eikon Haven Import — paste a URL or slug from eikon-haven.top to
// import eikons into the local gallery. Fetches metadata + .eikon file
// from Supabase, saves to ~/.hermes/eikons/<name>/, shows braille preview.

import { memo, useCallback, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { useTheme } from "../theme"
import { useToast } from "../ui/toast"
import { useDialog } from "../ui/dialog"
import { useKeys } from "../keys"
import { TabShell } from "../ui/shell"
import { HintBar } from "../ui/hint"
import { hermesPath } from "../service/hermes-home"
import { eikon } from "../service/eikon"
import { parseEikon, type ParsedEikon } from "../components/avatar/eikon"

const SB_URL = "https://ofoepdrohvrruonxpnsd.supabase.co"

type Row = {
  id: string
  name: string
  slug: string
  author?: string
  tags?: string[]
  file_path: string
}

type Imported = {
  name: string
  slug: string
  author?: string
  tags?: string[]
  preview?: ParsedEikon
}

type Props = {
  focused: boolean
}

const extractSlug = (raw: string): string => {
  const trimmed = raw.trim()
  const m = trimmed.match(/eikon-haven\.top\/eikon\/([a-z0-9_-]+)/i)
  return m ? m[1] : trimmed.replace(/[^a-z0-9_-]/gi, "").toLowerCase()
}

export const EikonImport = memo((props: Props) => {
  const theme = useTheme().theme
  const toast = useToast()
  const dialog = useDialog()
  const keys = useKeys()

  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [result, setResult] = useState<Imported | undefined>(undefined)
  const [recent, setRecent] = useState<Imported[]>([])

  const sbKey = process.env.SUPABASE_ANON_KEY

  const doImport = useCallback(async () => {
    const slug = extractSlug(input)
    if (!slug) return
    setBusy(true)
    setError(undefined)
    setResult(undefined)

    const headers: Record<string, string> = {
      Accept: "application/json",
    }
    if (sbKey) headers["apikey"] = sbKey
    if (sbKey) headers["Authorization"] = `Bearer ${sbKey}`

    try {
      const metaUrl = `${SB_URL}/rest/v1/eikons?slug=eq.${encodeURIComponent(slug)}&status=eq.approved&select=*`
      const metaRes = await fetch(metaUrl, { headers })
      if (!metaRes.ok) throw new Error(`HTTP ${metaRes.status}`)
      const rows: Row[] = await metaRes.json() as Row[]
      if (rows.length === 0) throw new Error(`No approved eikon found for "${slug}"`)
      const row = rows[0]

      const fileUrl = `${SB_URL}/storage/v1/object/public/eikons-public/${row.file_path}`
      const fileRes = await fetch(fileUrl)
      if (!fileRes.ok) throw new Error(`Download failed: HTTP ${fileRes.status}`)
      const text = await fileRes.text()

      const paths = eikon.ensure(row.slug)
      writeFileSync(join(paths.dir, `${row.slug}.eikon`), text, "utf8")

      let preview: ParsedEikon | undefined
      try { preview = parseEikon(text) } catch { /* ignore */ }

      // Fire-and-forget download tracking
      void fetch(`${SB_URL}/rest/v1/rpc/track_download`, {
        method: "POST",
        headers,
        body: JSON.stringify({ p_eikon_id: row.id }),
      }).catch(() => { /* ignore */ })

      const entry: Imported = { name: row.name, slug: row.slug, author: row.author, tags: row.tags, preview }
      setResult(entry)
      setRecent(p => [entry, ...p.filter(r => r.slug !== entry.slug).slice(0, 9)])
      setInput("")
      toast.show({ variant: "success", message: `Imported "${row.name}"` })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      toast.show({ variant: "error", title: "Import failed", message: msg })
    } finally {
      setBusy(false)
    }
  }, [input, sbKey, toast])

  const reset = useCallback(() => {
    setInput("")
    setError(undefined)
    setResult(undefined)
  }, [])

  useKeyboard(key => {
    if (!props.focused || dialog.open()) return
    if (key.name === "r" && !busy) { reset(); return }
  })

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <TabShell title="Import from Eikon Haven" focus={props.focused} grow={3}>
          <box flexDirection="column" padding={1} gap={1} flexGrow={1} minWidth={0}>
            <text fg={theme.textMuted}>Paste a URL or slug from eikon-haven.top:</text>
            <box flexDirection="row" gap={1}>
              <box flexGrow={1} minWidth={0}>
                <input
                  value={input}
                  onChange={setInput}
                  onSubmit={doImport}
                  placeholder="https://eikon-haven.top/eikon/ares or just ares"
                  focused={props.focused && !busy}
                />
              </box>
            </box>
            {busy ? <text fg={theme.primary}>Importing…</text> : null}
            {error ? <text fg={theme.error}>{error}</text> : null}
            {result ? (
              <box flexDirection="column" gap={0} marginTop={1}>
                <text fg={theme.success}><strong>✓ {result.name}</strong></text>
                {result.author ? <text fg={theme.textMuted}>  by {result.author}</text> : null}
                {result.tags && result.tags.length > 0
                  ? <text fg={theme.textMuted}>  tags: {result.tags.join(", ")}</text> : null}
              </box>
            ) : null}
            {!sbKey ? (
              <box flexDirection="column" marginTop={1}>
                <text fg={theme.warning}>⚠ SUPABASE_ANON_KEY not set</text>
                <text fg={theme.textMuted}>Set the env var to enable Eikon Haven imports.</text>
              </box>
            ) : null}
            {recent.length > 0 ? (
              <box flexDirection="column" marginTop={1}>
                <text fg={theme.textMuted}><strong>Recent imports:</strong></text>
                {recent.map(r => (
                  <text key={r.slug} fg={theme.text}>  • {r.name} ({r.slug})</text>
                ))}
              </box>
            ) : null}
          </box>
        </TabShell>
        <TabShell title={result ? `Preview — ${result.name}` : "Preview"} grow={2}>
          <box alignItems="center" justifyContent="center" flexGrow={1}>
            {result?.preview
              ? <Preview preview={result.preview} />
              : <text fg={theme.textMuted}>Import an eikon to see preview.</text>}
          </box>
        </TabShell>
      </box>
      <HintBar pairs={[
        ["Enter", "import"],
        ["r", "reset"],
        ...(!sbKey ? [["export SUPABASE_ANON_KEY", "required"] as const] : []),
      ]} />
    </box>
  )
})

const Preview = (props: { preview: ParsedEikon }) => {
  const theme = useTheme().theme
  const idle = props.preview.states.get("idle")
  if (!idle) return <text fg={theme.textMuted}>No idle state.</text>
  const frame = idle.frames[0]
  if (!frame) return <text fg={theme.textMuted}>Empty frame.</text>
  const rows = frame.slice(0, 8)
  return (
    <box flexDirection="column">
      {rows.map((line, i) => <text key={i}>{line}</text>)}
    </box>
  )
}
