// Create a kanban task — form dialog.
//
// Layout: a vertical form. Fields top-to-bottom: Title (input), Body
// (textarea), Assignee / Priority / Triage always visible; Tenant /
// Project / Workspace / Max runtime / Skills live under a collapsed "More"
// section ('m' toggles).
//
// Navigation:
//   ↑/↓            move focus between visible fields (wraps)
//   Tab / ⇧Tab     same, but also the ONLY way in/out of the Body
//                  textarea (it owns ↑/↓ for cursor movement); on the
//                  Skills field Tab commits the highlighted match to a
//                  chip if the filter has matches, otherwise moves field
//   ↑ at body top / ↓ at body bottom   escape the textarea to the
//                  adjacent field (the textarea lets edge arrows
//                  bubble; mid-buffer arrows move the cursor)
//   Space          on a select-type field (Assignee/Priority/
//                  Workspace) opens its picker; on Triage, toggles
//   Enter          submit — except in the Body textarea, where it
//                  inserts a newline
//   Ctrl+Enter     submit from anywhere
//   Esc            cancel
//
// Skills field:
//   typing         filters the available skills; matches render inline
//                  below the input
//   ↑/↓            navigate matches (only when filter non-empty and
//                  matches exist); otherwise move form field
//   Tab            commit the highlighted match as a chip; clears the
//                  filter. Falls through to field-nav when no matches.
//   Backspace      with empty filter, pops the last chip
//
// The picker is rendered INSIDE this component (a `picker` state swaps
// the field rows for a <DialogSelect>), so the form never unmounts and
// the <input>/<textarea> buffers survive a round-trip through a picker.

import { useState, useRef, useEffect, useMemo } from "react"
import { useKeyboard } from "@opentui/react"
import type { TextareaRenderable } from "@opentui/core"
import { useTheme } from "../theme"
import { useGateway } from "../context/gateway"
import type { DialogContext } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import type { SelectOption } from "../ui/dialog-select"
import { FilterChip } from "../ui/filter-chip"

export type Workspace =
  | { kind: "scratch" }
  | { kind: "worktree" }
  | { kind: "dir"; path: string }

export type Draft = {
  title: string
  body: string
  assignee: string | null
  priority: number
  parent: string | null
  triage: boolean
  tenant: string | null
  project: string | null
  workspace: Workspace
  maxRuntime: string | null
  skills: string[]
}

export function openCreateTask(
  dialog: DialogContext,
  opts: { assignees: string[]; parent?: { id: string; title: string } },
): Promise<Draft | null> {
  return new Promise(resolve => {
    const done = (r: Draft | null) => { dialog.clear(); resolve(r) }
    // ownCancel: the Form owns Esc — first press backs out of an open
    // sub-picker, only an Esc on the bare form cancels creation.
    dialog.replace(<Form pool={opts.assignees} parent={opts.parent} done={done} />,
      undefined, { ownCancel: true })
  })
}

// Visible-field identifiers. "More" is the collapsible header row.
type Field =
  | "title" | "body" | "assignee" | "priority" | "triage"
  | "more" | "tenant" | "project" | "workspace" | "maxRuntime" | "skills"

const CORE: Field[] = ["title", "body", "assignee", "priority", "triage", "more"]
const MORE: Field[] = ["tenant", "project", "workspace", "maxRuntime", "skills"]

// Fields that open a picker on Space.
const SELECTY: ReadonlySet<Field> = new Set(["assignee", "priority", "workspace"])

const MAX_RUNTIME_RE = /^\d+[smhd]?$/

// Cap on inline match rows to keep the dialog height bounded.
const SKILL_MATCHES_MAX = 6

const wsLabel = (w: Workspace): string =>
  w.kind === "scratch" ? "scratch"
    : w.kind === "worktree" ? "worktree"
      : `dir @ ${w.path}`

type Picker =
  | null
  | { kind: "assignee" }
  | { kind: "priority" }
  | { kind: "workspace" }
  | { kind: "dirPath"; value: string }

// A single installed skill, as returned by `skills.manage action=list`.
type Skill = { cat: string; name: string }

const Form = (p: {
  pool: string[]
  parent?: { id: string; title: string }
  done: (r: Draft | null) => void
}) => {
  const theme = useTheme().theme
  const gw = useGateway()
  const body = useRef<TextareaRenderable | null>(null)
  // <textarea> has no onInput(value) — we mirror its content into state
  // via onContentChange (reading .plainText off the ref) so the text
  // survives a remount when a picker view is shown, and feed it back as
  // initialValue.
  const [bodyText, setBodyText] = useState("")

  const [field, setField] = useState<Field>("title")
  const [more, setMore] = useState(false)
  const [picker, setPicker] = useState<Picker>(null)

  const [title, setTitle] = useState("")
  const [assignee, setAssignee] = useState<string | null>(null)
  const [priority, setPriority] = useState(0)
  const [triage, setTriage] = useState(false)
  const [tenant, setTenant] = useState("")
  const [project, setProject] = useState("")
  const [workspace, setWorkspace] = useState<Workspace>({ kind: "scratch" })
  const [maxRuntime, setMaxRuntime] = useState("")

  // Skills state.
  const [catalog, setCatalog] = useState<Skill[]>([])
  const [skills, setSkills] = useState<string[]>([])
  const [filter, setFilter] = useState("")
  const [matchIdx, setMatchIdx] = useState(0)

  useEffect(() => {
    let live = true
    gw.request<{ skills: Record<string, string[]> }>("skills.manage", { action: "list" })
      .then(r => {
        if (!live) return
        const raw = r.skills ?? {}
        const out: Skill[] = []
        for (const cat of Object.keys(raw)) {
          for (const name of raw[cat] ?? []) out.push({ cat, name })
        }
        out.sort((a, b) => a.name.localeCompare(b.name))
        setCatalog(out)
      })
      .catch(() => { /* leave catalog empty — typing still works, just no matches */ })
    return () => { live = false }
  }, [gw])

  // Skill matches: case-insensitive substring over name, excluding
  // already-picked skills. Capped at SKILL_MATCHES_MAX.
  const matches = useMemo(() => {
    if (!filter.trim()) return []
    const q = filter.trim().toLowerCase()
    const picked = new Set(skills)
    const hits: Skill[] = []
    for (const s of catalog) {
      if (picked.has(s.name)) continue
      if (s.name.toLowerCase().includes(q) || s.cat.toLowerCase().includes(q)) hits.push(s)
      if (hits.length >= SKILL_MATCHES_MAX) break
    }
    return hits
  }, [catalog, filter, skills])

  // Clamp match cursor when the list shrinks.
  useEffect(() => {
    if (matchIdx > 0 && matchIdx >= matches.length) setMatchIdx(Math.max(0, matches.length - 1))
  }, [matches.length, matchIdx])

  const order = (): Field[] => more ? [...CORE, ...MORE] : CORE
  const titleOk = title.trim().length > 0
  const runtimeOk = maxRuntime.trim() === "" || MAX_RUNTIME_RE.test(maxRuntime.trim())
  const valid = titleOk && runtimeOk

  const submit = () => {
    if (!valid) return
    p.done({
      title: title.trim(),
      body: (body.current?.plainText ?? bodyText).trim(),
      assignee,
      priority,
      parent: p.parent?.id ?? null,
      triage,
      tenant: tenant.trim() || null,
      project: project.trim() || null,
      workspace,
      maxRuntime: maxRuntime.trim() || null,
      skills,
    })
  }

  const moveField = (dir: 1 | -1) => {
    const o = order()
    const i = o.indexOf(field)
    const next = o[(i + dir + o.length) % o.length]
    setField(next)
    // Declarative focus (focused={field === "body"}) handles the
    // textarea; nothing else needs an imperative focus call.
  }

  // Open the picker for the currently-focused select field.
  const openPicker = () => {
    if (field === "assignee") return setPicker({ kind: "assignee" })
    if (field === "priority") return setPicker({ kind: "priority" })
    if (field === "workspace") return setPicker({ kind: "workspace" })
  }

  // Commit the highlighted match as a chip and clear the filter.
  const commitMatch = () => {
    const hit = matches[matchIdx]
    if (!hit) return false
    setSkills(s => s.includes(hit.name) ? s : [...s, hit.name])
    setFilter("")
    setMatchIdx(0)
    return true
  }

  const popSkill = () => setSkills(s => s.slice(0, -1))

  useKeyboard((key) => {
    // Picker owns the keyboard while open; DialogSelect has its own
    // useKeyboard. Esc backs out one level: dirPath → workspace picker
    // → form; any other picker → form.
    if (picker) {
      if (key.name === "escape") {
        setPicker(picker.kind === "dirPath" ? { kind: "workspace" } : null)
      }
      return
    }

    if (key.name === "escape") return p.done(null)
    if (key.name === "return") {
      if (key.ctrl) return submit()
      if (field !== "body") return submit()
      return // body textarea owns plain Enter (newline)
    }

    // Skills field owns the input buffer — intercept Tab/Bksp/arrows
    // and printable keys here so autocomplete works. Escape and Enter
    // are handled above so the form still cancels/submits from Skills.
    if (field === "skills") {
      if (key.name === "tab") {
        // Shift+Tab always moves fields (backwards). Plain Tab commits
        // a match; falls through to field-nav when filter is empty or
        // has no matches.
        if (!key.shift && commitMatch()) return
        return moveField(key.shift ? -1 : 1)
      }
      if (key.name === "backspace") {
        if (filter.length > 0) return setFilter(f => f.slice(0, -1))
        return popSkill()
      }
      if (key.name === "up") {
        if (matches.length > 0) return setMatchIdx(i => Math.max(0, i - 1))
        return moveField(-1)
      }
      if (key.name === "down") {
        if (matches.length > 0) return setMatchIdx(i => Math.min(matches.length - 1, i + 1))
        return moveField(1)
      }
      // Printable: append to filter. Limit to skill-name legal chars so
      // stray shortcuts don't land in the buffer; skill names use
      // [a-z0-9_-] plus `/` for "category/name" scoped search.
      if (key.raw && key.raw.length === 1 && /[A-Za-z0-9_\-/ ]/.test(key.raw)) {
        setFilter(f => f + key.raw)
        setMatchIdx(0)
      }
      return
    }

    if (key.name === "tab") return moveField(key.shift ? -1 : 1)

    // Arrow nav. ↑/↓ move focus between fields — EXCEPT inside the body
    // textarea, where they move the cursor and only spill over to
    // field-nav when the cursor is already on the first/last line.
    // `useKeyboard` fires before the textarea processes the key, so
    // logicalCursor.row here is the pre-move position.
    if (key.name === "up") {
      if (field === "body") {
        const row = body.current?.logicalCursor.row ?? 0
        if (row > 0) return // textarea moves the cursor up
      }
      return moveField(-1)
    }
    if (key.name === "down") {
      if (field === "body") {
        const row = body.current?.logicalCursor.row ?? 0
        const last = (body.current?.lineCount ?? 1) - 1
        if (row < last) return // textarea moves the cursor down
      }
      return moveField(1)
    }

    if (field === "more") {
      if (key.name === "return" || key.name === "space") return setMore(m => !m)
      return
    }
    if (field === "triage" && key.name === "space") return setTriage(t => !t)
    if (SELECTY.has(field) && key.name === "space") return openPicker()
  })
  if (picker?.kind === "assignee") {
    const opts: SelectOption[] = [
      { title: "(unassigned)", value: "" },
      ...p.pool.map(n => ({ title: n, value: n })),
    ]
    return (
      <DialogSelect
        title="Assignee" options={opts} placeholder="Search profiles…"
        current={assignee ?? ""}
        onSelect={o => { setAssignee(o.value || null); setPicker(null) }}
      />
    )
  }
  if (picker?.kind === "priority") {
    const opts: SelectOption[] = Array.from({ length: 10 }, (_, n) => ({
      title: n === 0 ? "P0 (none)" : `P${n}`,
      value: String(n),
      description: n === 0 ? "default"
        : n <= 2 ? "normal" : n <= 5 ? "elevated" : "high",
    }))
    return (
      <DialogSelect
        title="Priority" options={opts} filterable={false}
        current={String(priority)}
        onSelect={o => { setPriority(Number(o.value)); setPicker(null) }}
      />
    )
  }
  if (picker?.kind === "workspace") {
    const opts: SelectOption[] = [
      { title: "scratch", value: "scratch",
        description: "isolated temp dir under the board root (default)" },
      { title: "worktree", value: "worktree",
        description: "git worktree at .worktrees/<task-id> — worker runs `git worktree add`" },
      { title: "dir:…", value: "dir",
        description: "an exact absolute path (prompts next)" },
    ]
    return (
      <DialogSelect
        title="Workspace" options={opts} filterable={false}
        current={workspace.kind}
        onSelect={o => {
          if (o.value === "scratch") { setWorkspace({ kind: "scratch" }); return setPicker(null) }
          if (o.value === "worktree") { setWorkspace({ kind: "worktree" }); return setPicker(null) }
          return setPicker({ kind: "dirPath", value: workspace.kind === "dir" ? workspace.path : "" })
        }}
      />
    )
  }
  if (picker?.kind === "dirPath") {
    const val = picker.value
    const ok = val.trim().length > 0 && val.trim().startsWith("/")
    return (
      <box flexDirection="column" width={64}>
        <box height={1}><text fg={theme.primary}><strong>Directory path</strong></text></box>
        <box height={1} />
        <box height={1}><text fg={theme.textMuted}>absolute path (required)</text></box>
        <box height={1} flexDirection="row" overflow="hidden">
          <box flexShrink={0}><text fg={theme.accent}>{"┃ "}</text></box>
          <box flexGrow={1} minWidth={0} height={1} overflow="hidden">
            <input
              key="dirpath"
              value={val}
              onInput={v => setPicker({ kind: "dirPath", value: v })}
              onSubmit={() => {
                if (!ok) return
                setWorkspace({ kind: "dir", path: val.trim() })
                setPicker(null)
              }}
              focused
              textColor={theme.text}
              backgroundColor={theme.backgroundElement}
              focusedBackgroundColor={theme.backgroundElement}
            />
          </box>
        </box>
        <box height={1} />
        <box height={1}><text fg={theme.textMuted}>
          {ok ? "Enter confirm  ·  Esc back" : "absolute path required  ·  Esc back"}
        </text></box>
      </box>
    )
  }
  const lbl = (f: Field, text: string) => (
    <box width={13} flexShrink={0}>
      <text fg={field === f ? theme.accent : theme.textMuted}>
        {field === f ? "▸ " : "  "}{text}
      </text>
    </box>
  )

  // Single-line text field row.
  const textRow = (f: Field, label: string, value: string,
                   set: (v: string) => void, placeholder?: string) => (
    <box height={1} flexDirection="row">
      {lbl(f, label)}
      <box flexGrow={1} minWidth={0} height={1} overflow="hidden">
        <input
          key={`field-${f}`}
          value={value}
          onInput={set}
          onSubmit={submit}
          focused={field === f}
          placeholder={placeholder}
          textColor={theme.text}
          placeholderColor={theme.textMuted}
          backgroundColor={field === f ? theme.backgroundElement : undefined}
          focusedBackgroundColor={theme.backgroundElement}
        />
      </box>
    </box>
  )

  // Static read-only row (select-type value + affordance, or boolean).
  const valRow = (f: Field, label: string, value: string, hint: string) => (
    <box height={1} flexDirection="row">
      {lbl(f, label)}
      <box flexGrow={1} minWidth={0} height={1} overflow="hidden">
        <text fg={theme.text}>{value}</text>
      </box>
      {field === f ? <box flexShrink={0}><text fg={theme.textMuted}>{hint}</text></box> : null}
    </box>
  )

  // Skills row + inline match list. Chips render as FilterChip{state:in}
  // so they match every other pill in herm. The filter text sits at the
  // end of the chip row with a blinking cursor marker when focused.
  const skillsRows = () => {
    const focused = field === "skills"
    const empty = skills.length === 0 && !focused
    return (
      <>
        <box height={1} flexDirection="row">
          {lbl("skills", "Skills")}
          <box flexGrow={1} minWidth={0} height={1} flexDirection="row" overflow="hidden">
            {skills.map(n => (
              <FilterChip key={n} label={n} state="in" gap={0} />
            ))}
            {empty
              ? <text fg={theme.textMuted}>(none — focus field to pick)</text>
              : (
                <box flexDirection="row" marginLeft={skills.length > 0 ? 1 : 0}>
                  <text fg={theme.text}>{filter}</text>
                  {focused ? <text fg={theme.accent}>█</text> : null}
                </box>
              )}
          </box>
        </box>
        {focused && matches.length > 0 ? (
          <box flexDirection="column">
            {matches.map((s, i) => (
              <box key={`${s.cat}/${s.name}`} height={1} flexDirection="row">
                <box width={13} flexShrink={0}>
                  <text fg={i === matchIdx ? theme.accent : theme.textMuted}>
                    {i === matchIdx ? "  ▸ " : "    "}
                  </text>
                </box>
                <box flexGrow={1} minWidth={0} height={1} overflow="hidden">
                  <text>
                    <span fg={i === matchIdx ? theme.accent : theme.text}>{s.name}</span>
                    <span fg={theme.textMuted}>{`  ${s.cat}`}</span>
                  </text>
                </box>
              </box>
            ))}
          </box>
        ) : null}
      </>
    )
  }

  const skillsFooter = () => {
    if (matches.length > 0) return "Tab add  ·  ↑↓ pick  ·  Bksp remove  ·  Enter create  ·  Esc"
    if (skills.length > 0) return "type to filter  ·  Bksp remove last  ·  Enter create  ·  ↑↓/Tab  ·  Esc"
    return "type to filter  ·  Enter create  ·  ↑↓/Tab field  ·  Esc cancel"
  }

  const footer = !valid
    ? (!titleOk ? "type a title" : "fix runtime (e.g. 30m, 2h, 1800)")
    : field === "body"
      ? "Ctrl+Enter create  ·  Tab leave  ·  ↑↓ cursor  ·  Esc cancel"
      : field === "more"
        ? `Space ${more ? "collapse" : "expand"}  ·  Ctrl+Enter create  ·  ↑↓/Tab  ·  Esc`
        : field === "skills"
          ? skillsFooter()
          : SELECTY.has(field)
            ? "Space pick  ·  Enter create  ·  ↑↓/Tab field  ·  Esc cancel"
            : field === "triage"
              ? "Space toggle  ·  Enter create  ·  ↑↓/Tab field  ·  Esc"
              : "Enter create  ·  ↑↓/Tab field  ·  Esc cancel"

  return (
    <box flexDirection="column" width={66}>
      <box height={1}><text fg={theme.primary}><strong>
        {p.parent ? `New Task  ·  child of ${p.parent.id}` : "New Task"}
      </strong></text></box>
      {p.parent ? <box height={1}><text fg={theme.textMuted}>  {p.parent.title}</text></box> : null}
      <box height={1} />

      {textRow("title", "Title", title, setTitle, "one-line summary")}

      {/* Body textarea. keyBindings left at defaults; the React wrapper
          maps focused → .focus(). Edge ↑/↓ bubble to our handler.
          Content is read via the ref at submit time — <textarea> has
          no value-change callback that hands back text. */}
      <box flexDirection="row">
        {lbl("body", "Body")}
        <box flexGrow={1} minWidth={0}>
          <textarea
            key="field-body"
            ref={body}
            initialValue={bodyText}
            onContentChange={() => { if (body.current) setBodyText(body.current.plainText) }}
            focused={field === "body"}
            placeholder="longer spec — markdown ok (Enter for newline)"
            textColor={theme.text}
            placeholderColor={theme.textMuted}
            backgroundColor={field === "body" ? theme.backgroundElement : undefined}
            focusedBackgroundColor={theme.backgroundElement}
            minHeight={5}
            maxHeight={5}
          />
        </box>
      </box>

      {valRow("assignee", "Assignee", assignee ?? "(unassigned)", "Space pick ▾")}
      {valRow("priority", "Priority", priority ? `P${priority}` : "P0 (none)", "Space pick ▾")}
      {valRow("triage", "Triage", triage ? "yes — park for a specifier" : "no", "Space toggle")}

      <box height={1} flexDirection="row">
        <box width={13} flexShrink={0}>
          <text fg={field === "more" ? theme.accent : theme.textMuted}>
            {field === "more" ? "▸ " : "  "}{more ? "More ▾" : "More ▸"}
          </text>
        </box>
        {!more ? (
          <box flexGrow={1} height={1} overflow="hidden">
            <text fg={theme.textMuted}>tenant · project · workspace · runtime · skills</text>
          </box>
        ) : null}
      </box>

      {more ? textRow("tenant", "Tenant", tenant, setTenant, "namespace (optional)") : null}
      {more ? textRow("project", "Project", project, setProject, "id/slug (optional)") : null}
      {more ? valRow("workspace", "Workspace", wsLabel(workspace), "Space pick ▾") : null}
      {more ? textRow("maxRuntime", "Runtime", maxRuntime, setMaxRuntime, "e.g. 30m, 2h, 1800 (optional)") : null}
      {more ? skillsRows() : null}

      <box height={1} />
      <box height={1}><text fg={theme.textMuted}>{footer}</text></box>
    </box>
  )
}
