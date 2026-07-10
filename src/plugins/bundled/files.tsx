// Minimal file browser / markdown viewer as a plugin route. Exercises
// `api.route.register` + `api.command.register` and demonstrates a
// component reading theme through the api rather than deep-importing.

import { useEffect, useMemo, useState } from "react"
import { readdirSync, statSync } from "fs"
import { join, basename } from "path"
import { homedir } from "os"
import { useKeyboard } from "@opentui/react"
import type { ParsedKey } from "@opentui/core"
import { handleListKey } from "../../keys"
import type { HermPlugin, HermPluginApi } from "../types"

const PREVIEW_MAX = 200_000

type Row = { name: string; dir: boolean }

const read = (dir: string): Row[] => {
  const out: Row[] = dir === "/" ? [] : [{ name: "..", dir: true }]
  return out.concat(
    readdirSync(dir, { withFileTypes: true })
      .filter(d => !d.name.startsWith("."))
      .sort((a, b) => (a.isDirectory() === b.isDirectory()
        ? a.name.localeCompare(b.name)
        : a.isDirectory() ? -1 : 1))
      .map(d => ({ name: d.name, dir: d.isDirectory() })),
  )
}

const isMd = (name: string) => /\.(md|markdown|mdx)$/i.test(name)

function Files(props: { api: HermPluginApi; focused: boolean }) {
  const api = props.api
  const theme = api.theme.current
  const [dir, setDir] = useState(() => homedir())
  const [sel, setSel] = useState(0)
  const [preview, setPreview] = useState("")

  const listing = useMemo(() => {
    try { return { rows: read(dir), error: "" } }
    catch (e) { return { rows: [] as Row[], error: e instanceof Error ? e.message : String(e) } }
  }, [dir])
  const rows = listing.rows

  useEffect(() => { setSel(s => Math.min(s, Math.max(0, rows.length - 1))) }, [rows.length])
  const active = rows[sel]

  useEffect(() => {
    if (!active || active.dir) { setPreview(""); return }
    const path = join(dir, active.name)
    let cancel = false
    ;(async () => {
      const st = statSync(path)
      if (st.size > PREVIEW_MAX) { if (!cancel) setPreview(`(file too large — ${st.size} bytes)`); return }
      const text = await Bun.file(path).text()
      if (!cancel) setPreview(text)
    })().catch(e => { if (!cancel) setPreview(`(read error: ${e})`) })
    return () => { cancel = true }
  }, [dir, active?.name, active?.dir])

  const enter = () => {
    if (!active) return
    if (active.name === "..") { setDir(d => d === "/" ? "/" : join(d, "..")); setSel(0); return }
    if (active.dir) { setDir(d => join(d, active.name)); setSel(0) }
  }

  useKeyboard((key: ParsedKey) => {
    if (!props.focused || api.ui.dialog.open()) return
    if (key.name === "left") { setDir(d => d === "/" ? "/" : join(d, "..")); setSel(0); return }
    handleListKey(api.keys, key, { count: rows.length, setSel, onActivate: enter })
  })

  return (
    <box flexGrow={1} flexDirection="column">
      <box height={1} flexShrink={0} paddingX={1}>
        <text fg={theme.textMuted} wrapMode="none">{dir}</text>
      </box>
      <box flexGrow={1} flexDirection="row">
        <box width={32} flexShrink={0} flexDirection="column" border borderColor={theme.border}>
          {rows.map((e, i) => (
            <box key={e.name} height={1} paddingX={1}
                 backgroundColor={i === sel ? theme.backgroundElement : undefined}>
              <text fg={i === sel ? theme.selectedListItemText : (e.dir ? theme.accent : theme.text)}
                    wrapMode="none">
                {(e.dir ? "▸ " : "  ") + e.name}
              </text>
            </box>
          ))}
          {listing.error ? <box height={1} paddingX={1}><text fg={theme.error} wrapMode="none">{listing.error}</text></box> : null}
        </box>
        <box flexGrow={1} flexDirection="column" border borderColor={theme.border}>
          {active && !active.dir ? (
            <>
              <box height={1} flexShrink={0} paddingX={1}>
                <text fg={theme.textMuted} wrapMode="none">
                  {basename(active.name)}{isMd(active.name) ? "  ·  markdown" : ""}
                </text>
              </box>
              <scrollbox scrollY flexGrow={1}>
                <text fg={theme.text} wrapMode="word">{preview}</text>
              </scrollbox>
            </>
          ) : (
            <box paddingX={1}><text fg={theme.textMuted}>Select a file to preview.</text></box>
          )}
        </box>
      </box>
    </box>
  )
}

const plugin: HermPlugin = {
  id: "demo.files",
  enabled: false,
  tui(api) {
    api.route.register([{
      name: "Files",
      description: "File browser",
      render: ({ focused }) => <Files api={api} focused={focused} />,
    }])
    api.command.register([{
      title: "Files: open browser",
      value: "plugin.files.open",
      category: "Plugin",
      onSelect: () => api.route.navigate("Files"),
    }])
  },
}

export default plugin
