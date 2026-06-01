// Eikon Haven Import — paste a URL or slug from eikon-haven.top to
// import eikons into the local gallery. Fetches metadata + .eikon file
// from Supabase, saves to ~/.hermes/eikons/<name>/, shows preview.

import { memo, useCallback, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { useTheme } from "../theme"
import { useToast } from "../ui/toast"
import { hermesPath } from "../service/hermes-home"
import { eikon } from "../service/eikon"
import { AnimatedAvatar } from "../components/avatar/AnimatedAvatar"
import { parseEikon, type ParsedEikon } from "../components/avatar/eikon"

const SB = "https://ofoepdrohvrruonxpnsd.supabase.co"

type Row = { id: string; name: string; slug: string; author?: string; tags?: string[]; file_path: string }
type Imported = { name: string; slug: string; author?: string; tags?: string[]; preview?: ParsedEikon }
type Props = { focused: boolean }

const extractSlug = (raw: string) => {
  const m = raw.trim().match(/eikon-haven\.top\/eikon\/([a-z0-9_-]+)/i)
  return m ? m[1] : raw.trim().replace(/[^a-z0-9_-]/gi, "").toLowerCase()
}

const headers = () => {
  const k = process.env.SUPABASE_ANON_KEY ?? ""
  return { apikey: k, Authorization: `Bearer ${k}`, Accept: "application/json", "Content-Type": "application/json" }
}

export const EikonImport = memo((props: Props) => {
  const theme = useTheme().theme
  const toast = useToast()
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [result, setResult] = useState<Imported | undefined>()
  const [recent, setRecent] = useState<Imported[]>([])
  const noKey = !process.env.SUPABASE_ANON_KEY

  const run = useCallback(async (raw: string) => {
    const slug = extractSlug(raw)
    if (!slug) { setError("Paste a URL or eikon slug"); return }
    setBusy(true); setError(undefined); setResult(undefined)
    try {
      const url = `${SB}/rest/v1/eikons?slug=eq.${encodeURIComponent(slug)}&status=eq.approved&select=*`
      const res = await fetch(url, { headers: headers() })
      if (!res.ok) throw new Error(`Supabase ${res.status}`)
      const rows = (await res.json()) as Row[]
      if (!rows.length) throw new Error(`"${slug}" not found or not approved`)
      const row = rows[0]

      const { name } = await eikon.fetchSource(`${SB}/storage/v1/object/public/eikons-public/${row.file_path}`, { name: row.name })

      fetch(`${SB}/rest/v1/rpc/track_download`, {
        method: "POST", headers: headers(),
        body: JSON.stringify({ p_eikon_id: row.id }),
      }).catch(() => {})

      let preview: ParsedEikon | undefined
      try {
        const p = join(hermesPath("eikons"), name, `${name}.eikon`)
        preview = parseEikon(readFileSync(p, "utf8"))
      } catch {}

      const entry: Imported = { name, slug: row.slug, author: row.author, tags: row.tags, preview }
      setResult(entry)
      setRecent(p => [entry, ...p.slice(0, 9)])
      setInput("")
      toast.show({ variant: "success", message: `Imported ${row.name}` })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }, [toast])

  useKeyboard((key) => {
    if (!props.focused || key.name !== "return") return
    void run(input)
  })

  if (noKey) return (
    <box flexDirection="column" flexGrow={1} padding={1}>
      <text fg={theme.accent}>⣿ Import from Eikon Haven</text>
      <text fg={theme.error} paddingTop={1}>SUPABASE_ANON_KEY not set.</text>
      <text fg={theme.textMuted}>export SUPABASE_ANON_KEY="eyJ..." in your shell or ~/.hermes/.env</text>
    </box>
  )

  return (
    <box flexDirection="column" flexGrow={1} padding={1}>
      <text fg={theme.accent}>⣿ Import from Eikon Haven</text>
      <box flexDirection="column" paddingTop={1}>
        <input
          value={input} onInput={setInput} onSubmit={() => void run(input)}
          focused={props.focused} textColor={theme.text}
          backgroundColor={theme.backgroundElement}
          focusedBackgroundColor={theme.backgroundElement} flexGrow={1}
        />
        <text fg={theme.textMuted}> Paste a URL from eikon-haven.top or just the slug  •  Enter to import</text>

        {busy && <text fg={theme.warning} paddingTop={1}> Fetching eikon…</text>}
        {error && <text fg={theme.error} paddingTop={1}> ✗ {error}</text>}

        {result && (
          <box flexDirection="column" paddingTop={1}>
            <box flexDirection="row" gap={1}>
              <text fg={theme.success}>✓ Imported</text>
              <text fg={theme.text}>{result.name}</text>
              {result.author && <text fg={theme.textMuted}>by {result.author}</text>}
            </box>
            {result.tags && result.tags.length > 0 && <text fg={theme.textMuted}> {result.tags.join(", ")}</text>}
            {result.preview && (
              <box flexDirection="column" paddingTop={1} border borderColor={theme.border}>
                <AnimatedAvatar state="idle" eikon={result.preview} />
              </box>
            )}
          </box>
        )}

        {recent.length > 0 && (
          <box flexDirection="column" paddingTop={1}>
            <text fg={theme.textMuted}> Recent imports</text>
            {recent.map((r, i) => (
              <box key={i} flexDirection="row" gap={1}>
                <text fg={theme.success}>✓</text>
                <text fg={theme.text}>{r.name}</text>
                {r.author && <text fg={theme.textMuted}>by {r.author}</text>}
              </box>
            ))}
          </box>
        )}
      </box>
    </box>
  )
})
