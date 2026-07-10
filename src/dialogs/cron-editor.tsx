import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { useTheme } from "../theme"
import type { ThemeCurrent } from "../theme"
import type { DialogContext } from "../ui/dialog"
import type { CronDraft } from "../tabs/cron-model"
import { cronModel } from "../tabs/cron-model"

type Field = keyof CronDraft | "submit"
type Result = { draft: CronDraft }

type Props = {
  mode: "create" | "edit"
  initial: CronDraft
  fields?: ReadonlySet<string>
  done: (r: Result | null) => void
}

const FIELDS: readonly Field[] = [
  "name", "schedule", "prompt", "script", "no_agent", "attach_to_session", "skills",
  "provider", "model", "base_url", "context_from", "enabled_toolsets",
  "workdir", "deliver", "repeat", "submit",
] as const

const LABELS: Record<Field, string> = {
  id: "ID",
  name: "Name",
  schedule: "Schedule",
  prompt: "Prompt",
  script: "Script",
  no_agent: "No agent",
  attach_to_session: "Attach session",
  skills: "Skills",
  provider: "Provider",
  model: "Model",
  base_url: "Base URL",
  context_from: "Context from",
  enabled_toolsets: "Toolsets",
  workdir: "Workdir",
  deliver: "Deliver",
  repeat: "Repeat",
  submit: "",
}

const HELP: Partial<Record<Field, string>> = {
  name: "blank lets the server derive one on create",
  schedule: "cron expr, ISO timestamp, or 'every 30m'",
  prompt: "required for agent jobs unless skills or script are set",
  script: "required when no_agent is on",
  attach_to_session: "continuable job deliveries; no effect with local delivery",
  skills: "comma or newline separated",
  context_from: "job ids; not returned by old gateways",
  enabled_toolsets: "comma or newline separated",
  deliver: "local, all, origin, or gateway target",
  repeat: "positive integer; blank uses gateway default",
}

const multiline = new Set<Field>(["prompt", "skills", "context_from", "enabled_toolsets"])
const bools = new Set<Field>(["no_agent", "attach_to_session"])
const basic = new Set<Field>(["name", "schedule", "prompt", "submit"])
const editable = (f: Field, p: Props) => (f !== "submit" && f !== "id" && f !== "name") || (p.mode === "create" && f === "name")
const available = (f: Field, p: Props) => basic.has(f) || p.fields === undefined || p.fields.has(f)

const value = (d: CronDraft, f: Field) => f === "submit" ? "" : d[f]
const height = (f: Field) => multiline.has(f) ? 3 : 1

const set = (d: CronDraft, f: Field, v: string | boolean): CronDraft => {
  if (f === "submit") return d
  return { ...d, [f]: v }
}

const FieldRow = (p: {
  field: Field
  draft: CronDraft
  active: boolean
  disabled: boolean
  theme: ThemeCurrent
}) => {
  const f = p.field
  const val = value(p.draft, f)
  const fg = p.disabled ? p.theme.textMuted : p.active ? p.theme.accent : p.theme.text
  if (f === "submit") return (
    <box height={1} marginTop={1}>
      <text fg={p.active ? p.theme.accent : p.theme.textMuted}>[Ctrl+Enter] save</text>
    </box>
  )
  return (
    <box minHeight={height(f)} flexDirection="row" marginTop={f === "prompt" ? 1 : 0}>
      <box width={16} flexShrink={0}><text fg={p.active ? p.theme.accent : p.theme.textMuted}>{p.active ? "▸ " : "  "}{LABELS[f]}</text></box>
      <box flexGrow={1} minWidth={0} flexDirection="column">
        {typeof val === "boolean" ? (
          <text fg={fg}>{val ? "● true" : "○ false"}</text>
        ) : (
          <box height={height(f)} overflow="hidden" backgroundColor={p.active && !p.disabled ? p.theme.backgroundElement : undefined}>
            <text wrapMode={multiline.has(f) ? "word" : undefined} fg={fg}>{val || (p.active ? "█" : "—")}</text>
          </box>
        )}
        {p.active && HELP[f] ? <text fg={p.theme.textMuted}>{HELP[f]}</text> : null}
      </box>
    </box>
  )
}

const CronEditor = (props: Props) => {
  const theme = useTheme().theme
  const [draft, setDraft] = useState(props.initial)
  const [field, setField] = useState<Field>("schedule")
  const [err, setErr] = useState<string | null>(null)
  const fields = FIELDS.filter(f => available(f, props))

  const move = (dir: 1 | -1) => {
    const i = fields.indexOf(field)
    setField(fields[(i + dir + fields.length) % fields.length] ?? "schedule")
  }
  const submit = () => {
    const msg = cronModel.validate(draft)
    if (msg) { setErr(msg); return }
    props.done({ draft })
  }
  const append = (raw: string) => setDraft(d => {
    const v = value(d, field)
    if (typeof v !== "string") return d
    return set(d, field, v + raw)
  })
  const back = () => setDraft(d => {
    const v = value(d, field)
    if (typeof v !== "string") return d
    return set(d, field, v.slice(0, -1))
  })

  useKeyboard(key => {
    if (key.name === "escape") return props.done(null)
    if (key.name === "tab") return move(key.shift ? -1 : 1)
    if (key.ctrl && key.name === "return") return submit()
    if (key.name === "up") return move(-1)
    if (key.name === "down") return move(1)
    if (field === "submit" && key.name === "return") return submit()
    if (!editable(field, props)) return
    if (bools.has(field) && (key.name === "space" || key.name === "return")) {
      setDraft(d => set(d, field, !value(d, field)))
      return
    }
    if (bools.has(field)) return
    if (key.name === "backspace") return back()
    if (key.name === "return") {
      if (multiline.has(field)) return append("\n")
      return move(1)
    }
    if (key.raw && key.raw.length === 1 && key.raw >= " ") return append(key.raw)
  })

  return (
    <box flexDirection="column" width={84} maxHeight={34}>
      <box height={1}><text fg={theme.primary}><strong>{props.mode === "create" ? "New Cron Job" : "Edit Cron Job"}</strong></text></box>
      {props.fields?.size === 0 ? (
        <text fg={theme.warning}>Current gateway only accepts name, schedule, and prompt.</text>
      ) : null}
      <box height={1} />
      <scrollbox scrollY flexGrow={1}>
        <box flexDirection="column">
          {fields.map(f => <FieldRow key={f} field={f} draft={draft} active={f === field} disabled={false} theme={theme} />)}
        </box>
      </scrollbox>
      {err ? <text fg={theme.error}>{err}</text> : null}
      <box height={1}><text fg={theme.textMuted}>Tab field  ·  ↑↓ field  ·  Ctrl+Enter save  ·  Esc cancel</text></box>
    </box>
  )
}

export function openCronEditor(
  dialog: DialogContext,
  opts: { mode: "create" | "edit"; initial: CronDraft; fields?: ReadonlySet<string> },
): Promise<Result | null> {
  return new Promise(resolve => {
    dialog.replace(
      <CronEditor
        mode={opts.mode}
        initial={opts.initial}
        fields={opts.fields}
        done={r => { resolve(r); dialog.clear() }}
      />,
      () => resolve(null),
      { ownCancel: true },
    )
  })
}
