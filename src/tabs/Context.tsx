/**
 * Context tab — two-level drill-down context window visualizer.
 *
 * Level 0: System Prompt | System Tools | MCP Tools | Memory |
 *          Skills | Conversation | Free
 * Level 1: Click a group → grid expands to show children
 * Detail:  Click a leaf → right panel shows content
 *
 * The grid always fills 16×16 = 256 cells.
 * At level 0, cells are proportional to the full context window.
 * At level 1, cells are proportional to the drilled group's total.
 */

import { useEffect, useState, useRef, useMemo, memo, type Dispatch, type SetStateAction } from "react"
import { CORNERS } from "../ui/borders"
import { useKeyboard } from "@opentui/react"

import type { Message, Usage } from "../types/message"
import { text as msgText } from "../types/message"
import { makeSource, type ToolInfo, type HermesConfig, type ToolsInfo } from "../service/hermes-home"
import type { ContextBreakdownResponse, ContextUsageCategory, SessionInfo } from "../context/wire"
import { useHome, home } from "../home"
import { useGateway } from "../context/gateway"
import { useKeys, handleListKey } from "../keys"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { openTextPrompt } from "../dialogs/text-prompt"
import { count } from "../utils/tokens"
import {
  parse,
  build,
  drill,
  cells as buildCells,
  classifyTools,
  toolTokens,
  type Segment,
} from "../service/context-segments"
import { FileLink } from "../components/ui/FileLink"
import { useTheme, type Theme } from "../theme"
import { TabShell } from "../ui/shell"
import { HintBar } from "../ui/hint"
import { categorical } from "../utils/categorical"
import type { RGBA } from "@opentui/core"

type Props = {
  description?: string
  messages?: Message[]
  sessionStart?: number
  info?: SessionInfo
  usage?: Usage
  focused?: boolean
}

type Wire = { input: number; output: number; total: number; calls: number }
type ContextMeter = { max: number; used?: number }
type RemoteBreakdown = {
  categories: ContextUsageCategory[]
  context_max: number
  context_used: number
  estimated_total: number
  model?: string
}

// Last-resort fallback when neither the gateway (info.context_max) nor
// config (model.context_length) has surfaced a window yet. Real value
// comes from SessionInfo.context_max on the wire; the configured
// model.context_length is preferred over this constant.
const DEFAULT_CTX = 128_000
const COLS = 16

// Slot assignment for the categorical ramp. Order matters only in that it
// fixes each id to a stable hue family across themes; `free` is not a slot
// (it renders as borderSubtle since it's absence-of-content, not a category).
export const SLOTS = [
  "system_prompt",
  "system_tools",
  "mcp_tools",
  "memory",
  "skills",
  "conversation",
  "soul",
  "mem0",
  "user",
  "project",
  "meta",
  "other",
  "unknown",
  "overage",
] as const

const SLOT: Record<string, number> = Object.fromEntries(SLOTS.map((id, i) => [id, i]))
const REMOTE: Record<string, string> = {
  tool_definitions: "system_tools",
  mcp: "mcp_tools",
  rules: "system_prompt",
  subagent_definitions: "system_tools",
}
const ORDER = ["system_prompt", "system_tools", "mcp_tools", "memory", "skills", "conversation"]
const LABEL: Record<string, string> = {
  system_prompt: "System Prompt",
  system_tools: "System Tools",
  mcp_tools: "MCP Tools",
  memory: "Memory",
  skills: "Skills",
  conversation: "Conversation",
}

// Ramp is deterministic per theme; cache on theme identity so every clr()
// call across all panels resolves from one array. Theme objects are stable
// (resolved once in ThemeProvider), so WeakMap keying is safe.
const rampCache = new WeakMap<Theme, RGBA[]>()

function ramp(theme: Theme): RGBA[] {
  let r = rampCache.get(theme)
  if (!r) rampCache.set(theme, r = categorical(theme.primary, theme.background, SLOTS.length))
  return r
}

export function clr(id: string, theme: Theme): RGBA {
  if (id === "free") return theme.borderSubtle
  return ramp(theme)[SLOT[id] ?? SLOT.other]
}

const fmt = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

const est = (s: string) => s ? count(s) : 0

const bar = (pct: number, w = 20) => {
  const f = Math.round((Math.max(0, Math.min(100, pct)) / 100) * w)
  return `[${"█".repeat(f)}${"░".repeat(Math.max(0, w - f))}]`
}

/** Generic section detail — renders the raw document body as markdown. */
const SectionPanel = memo(({ seg, theme }: { seg: Segment; theme: Theme }) => {
  const { syntaxStyle } = useTheme()
  const sec = seg.section
  if (!sec) return null
  return (
    <scrollbox borderStyle="single" padding={1} flexGrow={1} scrollY>
      <text>
        <strong><span fg={clr(seg.id, theme)}>◼</span> {seg.label} — {fmt(seg.tokens)} tokens ({seg.percent.toFixed(1)}%)</strong>
      </text>
      <text>{sec.chars.toLocaleString()} chars · ~{fmt(sec.tokens)} tokens</text>
      {sec.source ? <box flexDirection="row" height={1}><text>Source: </text><FileLink source={sec.source} /></box> : null}
      <text> </text>
      <markdown content={sec.text} fg={theme.markdownText} syntaxStyle={syntaxStyle} />
    </scrollbox>
  )
})

/** Memory detail with capacity bar + entries */
const MemoryPanel = memo(({ seg, theme, label, chars, limit, pct, entries, source }: {
  seg: Segment; theme: Theme; label: string
  chars: number; limit: number; pct: number; entries: string[]
  source?: { file: string; relative: string; label: string }
}) => (
  <scrollbox borderStyle="single" padding={1} flexGrow={1} scrollY>
    <text>
      <strong><span fg={clr(seg.id, theme)}>◼</span> {seg.label} — {fmt(seg.tokens)} tokens ({seg.percent.toFixed(1)}%)</strong>
    </text>
    <text> </text>
    <box flexDirection="row" height={1}>
      <text><strong>{label}</strong></text>
      {source ? <><text> (</text><FileLink source={source} /><text>)</text></> : null}
    </box>
    <text>{chars.toLocaleString()} / {limit.toLocaleString()} chars ({pct}%)</text>
    <text>{bar(pct, 25)}{pct >= 95 ? " ⚠ near limit" : ""}</text>
    <text> </text>
    <text>{entries.length} entries:</text>
    {entries.map((e, i) => <text key={i} fg={theme.text}>· {e}</text>)}
  </scrollbox>
))

/** Skills detail with category breakdown */
const SkillsPanel = memo(({ seg, theme }: { seg: Segment; theme: Theme }) => {
  const sec = seg.section
  if (!sec) return null
  const cats: Record<string, number> = {}
  for (const line of sec.text.split("\n")) {
    if (line.match(/^\s{2}(\S[\w-]*(?:\/\S+)?):\s/)) {
      const cat = line.match(/^\s{2}(\S[\w-]*(?:\/\S+)?):\s/)![1]
      if (!cats[cat]) cats[cat] = 0
    }
    if (line.match(/^\s{4}- \S+:/)) {
      const last = Object.keys(cats).pop()
      if (last) cats[last]++
    }
  }
  const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1])
  const total = sorted.reduce((s, [, n]) => s + n, 0)

  return (
    <scrollbox borderStyle="single" padding={1} flexGrow={1} scrollY>
      <text>
        <strong><span fg={clr("skills", theme)}>◼</span> Skills Catalog — {fmt(seg.tokens)} tokens ({seg.percent.toFixed(1)}%)</strong>
      </text>
      {sec.source ? <box flexDirection="row" height={1}><text>Source: </text><FileLink source={sec.source} /></box> : null}
      <text> </text>
      <text>{total} skills in {sorted.length} categories · {sec.chars.toLocaleString()} chars</text>
      <text fg={theme.textMuted}>Largest context section — skill names + descriptions injected every turn.</text>
      <text> </text>
      {sorted.map(([cat, n]) => <text key={cat} fg={theme.text}>· {cat} ({n})</text>)}
    </scrollbox>
  )
})

/** Tools detail — handles system builtins or MCP depending on `kind` */
const ToolsPanel = memo(({ seg, theme, tools, kind }: {
  seg: Segment; theme: Theme; tools: ReadonlyArray<ToolInfo>
  kind: "system_tools" | "mcp_tools"
}) => {
  const sorted = [...tools].sort((a, b) =>
    (b.descriptionLength + b.paramsLength) - (a.descriptionLength + a.paramsLength),
  )
  const label = kind === "mcp_tools" ? "MCP Tools" : "System Tools"
  const blurb = kind === "mcp_tools"
    ? "MCP-loaded tools — schemas injected via mcp_ prefix."
    : "Built-in tool schemas sent with every API call."
  return (
    <scrollbox borderStyle="single" padding={1} flexGrow={1} scrollY>
      <text>
        <strong><span fg={clr(kind, theme)}>◼</span> {label} — {fmt(seg.tokens)} tokens ({seg.percent.toFixed(1)}%)</strong>
      </text>
      <text> </text>
      <text>{tools.length} tools — {blurb}</text>
      <text> </text>
      {sorted.map(t => (
        <text key={t.name} fg={theme.text}>
          · {t.name} ({fmt(toolTokens(t))} tok)
        </text>
      ))}
    </scrollbox>
  )
})

/** Conversation detail */
const ConvPanel = memo(({ seg, theme, messages, output }: {
  seg: Segment; theme: Theme; messages: Message[]; output: number
}) => {
  const user = messages.filter(m => m.role === "user")
  const asst = messages.filter(m => m.role === "assistant")
  const non = messages.filter(m => m.role !== "system")
  return (
    <scrollbox borderStyle="single" padding={1} flexGrow={1} scrollY>
      <text>
        <strong><span fg={clr("conversation", theme)}>◼</span> Conversation — {fmt(seg.tokens)} tokens ({seg.percent.toFixed(1)}%)</strong>
      </text>
      <text> </text>
      <text>User: {user.length} msgs (~{fmt(est(user.map(m => msgText(m)).join("")))} tok)</text>
      <text>Agent: {asst.length} msgs (~{fmt(est(asst.map(m => msgText(m)).join("")))} tok)</text>
      {output > 0 ? <text>Output generated: {fmt(output)} tokens</text> : null}
      <text> </text>
      {non.length > 0 ? (
        <>
          <text fg={theme.info}>Messages:</text>
          <text> </text>
          {non.map((m, i) => (
            <text key={i}>
              <span fg={m.role === "user" ? theme.info : theme.success}>
                {m.role === "user" ? "▸ You" : "◂ Agent"}
              </span>{" "}({fmt(est(msgText(m)))}) {msgText(m).replace(/\n/g, " ")}
            </text>
          ))}
        </>
      ) : <text fg={theme.warning}>No messages yet</text>}
    </scrollbox>
  )
})

/** Free space detail */
const FreePanel = memo(({ seg, theme, ctxLen, comp, onEditThreshold }: {
  seg: Segment; theme: Theme; ctxLen: number
  comp: HermesConfig["compression"] | undefined
  onEditThreshold: () => void
}) => {
  const used = ctxLen - seg.tokens
  const threshold = Math.round(ctxLen * (comp?.threshold ?? 0.5))
  const pct = threshold > 0 ? Math.min(100, Math.round((used / threshold) * 100)) : 0
  return (
    <scrollbox borderStyle="single" padding={1} flexGrow={1} scrollY>
      <text><strong><span fg={clr("free", theme)}>◻</span> Free Space — {fmt(seg.tokens)} tokens</strong></text>
      <text> </text>
      <text>Context window: {fmt(ctxLen)}</text>
      <text>Used: {fmt(used)} ({Math.round((used / ctxLen) * 100)}%)</text>
      <text>Available: {fmt(seg.tokens)} ({seg.percent.toFixed(1)}%)</text>
      <text> </text>
      {comp ? (
        <>
          <text><strong>Compression</strong></text>
          <box height={1} flexDirection="row">
            <text>{comp.enabled ? "✓ Enabled" : "✗ Disabled"} · threshold </text>
            <box flexShrink={0} onMouseDown={onEditThreshold}>
              <text fg={theme.info}><u>{Math.round(comp.threshold * 100)}%</u></text>
            </box>
            <text> ({fmt(threshold)})</text>
          </box>
          <text>{bar(pct)} {pct}%</text>
          <text>Protect last {comp.protect_last_n} messages · target ratio {Math.round(comp.target_ratio * 100)}%</text>
          {comp.summary_model ? <text>Summary model: {comp.summary_model}</text> : null}
        </>
      ) : null}
    </scrollbox>
  )
})

// Stable empty default so memo comparison and downstream useEffect
// deps don't see a fresh [] reference on every render.
const NO_MESSAGES: readonly Message[] = Object.freeze([])

const toolsFromInfo = (info?: SessionInfo | null): ToolsInfo | null => {
  if (!info || info.tools === undefined) return null
  const tools = Object.entries(info.tools).flatMap(([group, names]) =>
    names.map(name => ({
      name,
      descriptionLength: 0,
      paramsLength: group.length,
    })),
  )
  return { source: makeSource("state.db", "session.info"), tools }
}

const configuredContextLength = (config: HermesConfig | null): number | undefined => {
  const n = config?.model?.context_length
  return typeof n === "number" && n > 0 ? n : undefined
}

export const contextMeter = (usage: Usage | undefined, info: SessionInfo | undefined, config: HermesConfig | null): ContextMeter => ({
  max: usage?.context_max ?? info?.usage?.context_max ?? info?.context_max ?? configuredContextLength(config) ?? DEFAULT_CTX,
  used: usage?.context_used ?? info?.usage?.context_used ?? info?.context_used,
})

export const contextBreakdown = (data: unknown): RemoteBreakdown | null => {
  if (!data || typeof data !== "object") return null
  const raw = data as ContextBreakdownResponse
  const max = Number(raw.context_max)
  const used = Number(raw.context_used)
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(used) || used < 0) return null
  if (!Array.isArray(raw.categories)) return null
  const categories = raw.categories.flatMap(cat => {
    if (!cat || typeof cat !== "object") return []
    const id = typeof cat.id === "string" ? cat.id.trim() : ""
    const label = typeof cat.label === "string" ? cat.label.trim() : ""
    const tokens = Number(cat.tokens)
    if (!id || !label || !Number.isFinite(tokens) || tokens < 0) return []
    return [{ id, label, tokens, color: typeof cat.color === "string" ? cat.color : undefined }]
  })
  return {
    categories,
    context_max: max,
    context_used: Math.min(used, max),
    estimated_total: Number.isFinite(Number(raw.estimated_total)) ? Math.max(0, Number(raw.estimated_total)) : 0,
    model: typeof raw.model === "string" ? raw.model : undefined,
  }
}

export const remoteSegments = (data: RemoteBreakdown, local: ReadonlyArray<Segment>): Segment[] => {
  const byId = new Map(local.map(seg => [seg.id, seg]))
  const bucket = new Map<string, { label: string; tokens: number }>()
  for (const cat of data.categories) {
    const id = REMOTE[cat.id] ?? cat.id
    const prev = bucket.get(id)
    bucket.set(id, { label: byId.get(id)?.label ?? prev?.label ?? cat.label, tokens: (prev?.tokens ?? 0) + cat.tokens })
  }
  const pct = (n: number) => data.context_max > 0 ? (n / data.context_max) * 100 : 0
  const ids = [...ORDER, ...bucket.keys().filter(id => !ORDER.includes(id))]
  const segs = ids.flatMap(id => {
    const cat = bucket.get(id)
    if (!cat || cat.tokens <= 0) return []
    const seg = byId.get(id)
    return [{
      ...(seg ?? {}),
      id,
      label: seg?.label ?? LABEL[id] ?? cat.label,
      tokens: cat.tokens,
      percent: pct(cat.tokens),
    }]
  })
  const taken = segs.reduce((sum, seg) => sum + seg.tokens, 0)
  const unknown = Math.max(0, data.context_used - taken)
  if (unknown > 0) segs.push({ id: "unknown", label: "Unknown / Provider Overhead", tokens: unknown, percent: pct(unknown) })
  const free = Math.max(0, data.context_max - data.context_used)
  segs.push({ id: "free", label: "Free", tokens: free, percent: pct(free) })
  return segs
}

export const Context = memo(({ messages = NO_MESSAGES as Message[], info, usage, focused }: Props) => {
  const config = useHome("config")
  const memory = useHome("memory")
  const userProfile = useHome("userProfile")
  const gw = useGateway()
  const dialog = useDialog()
  const toast = useToast()
  const systemPrompt = useHome("systemPrompt")
  const toolsInfo = useHome("toolsInfo")
  const soul = useHome("soul")

  const [wire, setWire] = useState<Wire>({ input: 0, output: 0, total: 0, calls: 0 })
  const wireRef = useRef(wire)
  const theme = useTheme().theme
  const [hovered, setHovered] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [drilled, setDrilled] = useState<string | null>(null)
  const [remote, setRemote] = useState<RemoteBreakdown | null>(null)

  // Track wire usage from messages
  useEffect(() => {
    let input = 0, output = 0, total = 0, calls = 0
    for (const m of messages) {
      if (m.usage) {
        input += m.usage.input
        output += m.usage.output
        total += m.usage.total
        calls++
      }
    }
    const next: Wire = { input, output, total, calls }
    wireRef.current = next
    setWire(next)
  }, [messages])

  const rev = usage?.context_used ?? info?.usage?.context_used ?? info?.context_used
  // Context accounting is expensive upstream; wait for usage/message bursts
  // to settle and ignore superseded responses.
  useEffect(() => {
    const sid = info?.session_id
    if (!sid) {
      setRemote(null)
      return
    }
    let done = false
    const timer = setTimeout(() => {
      void gw.request<ContextBreakdownResponse>("session.context_breakdown", { session_id: sid })
        .then(data => { if (!done) setRemote(contextBreakdown(data)) })
        .catch(() => { if (!done) setRemote(null) })
    }, 300)
    return () => { done = true; clearTimeout(timer) }
  }, [gw, info?.session_id, info?.usage?.compressions, messages.length, rev])

  // Derived
  const localMeter = contextMeter(usage, info, config ?? null)
  const meter = remote ? { max: remote.context_max, used: remote.context_used } : localMeter
  const ctxLen = meter.max
  const used = meter.used
  const reliable = typeof used === "number"
  const output = wire.output
  const pct = reliable && ctxLen > 0 ? Math.round((used / ctxLen) * 100) : 0

  // Threshold marker inputs. `config.compression.threshold` is the
  // single source of truth; server reads the same key.
  const thresholdPct = config?.compression?.threshold ?? 0.5
  // Linear cell index (0..255) at threshold; cells at/past render ◼ in textMuted.
  const thresholdIdx = Math.min(COLS * COLS, Math.max(0, Math.round(thresholdPct * COLS * COLS)))
  const compressions = info?.usage?.compressions ?? 0

  // Parse + build
  // Prefer the live wire prompt (info.system_prompt = agent._cached_system_prompt,
  // reflects mid-session personality/skin switches). Fall back to state.db via
  // useHome during the pre-session.info window or on older gateways that don't
  // send the field.
  const promptText = info?.system_prompt ?? systemPrompt?.text ?? ""
  const sections = useMemo(() => parse(promptText), [promptText])
  const convTok = useMemo(() => est(messages.filter(m => m.role !== "system").map(m => msgText(m)).join("")), [messages])

  const currentTools = useMemo(() => {
    const liveTools = toolsFromInfo(info)
    if (liveTools) return liveTools
    if (info?.tools !== undefined) return liveTools
    return toolsInfo
  }, [info, toolsInfo])

  const local = useMemo(() => build({
    contextLength: ctxLen,
    usedTokens: used,
    sections,
    conversationTokens: convTok,
    tools: currentTools?.tools ?? [],
  }), [ctxLen, used, sections, convTok, currentTools])
  const top = useMemo(() => remote ? remoteSegments(remote, local) : local, [remote, local])

  // Current view: top-level or drilled
  const drilledGroup = drilled ? top.find(s => s.id === drilled) : null
  const view = drilledGroup ? drill(drilledGroup) : top
  const grid = useMemo(
    () => buildCells(view, drilledGroup ? drilledGroup.children?.[0]?.id ?? "other" : reliable ? "free" : "unknown"),
    [view, drilledGroup, reliable],
  )

  // Helpers
  const findSeg = (id: string) => {
    if (drilledGroup) return view.find(s => s.id === id)
    return top.find(s => s.id === id)
  }

  const memEntries = useMemo(() => (memory?.content ?? "").split("§").map(s => s.trim()).filter(Boolean), [memory?.content])
  const userEntries = useMemo(() => (userProfile?.content ?? "").split("§").map(s => s.trim()).filter(Boolean), [userProfile?.content])

  // Click handler
  const click = (id: string) => {
    // Already drilled — clicking selects detail or deselects
    if (drilled) {
      setSelected(selected === id ? null : id)
      return
    }
    // Top level — if group with children, drill in
    const seg = top.find(s => s.id === id)
    if (seg?.children && seg.children.length > 0) {
      setDrilled(id)
      setSelected(null)
      return
    }
    // Leaf at top level — toggle detail
    setSelected(selected === id ? null : id)
  }

  // Esc pops one drill level (detail → group → overview); double-tap
  // within 400ms jumps straight to overview. Replaces the '◀ Back to
  // overview' row, which stole a line above the grid and broke
  // top-alignment with the breakdown pane.
  const lastEsc = useRef(0)
  // Keyboard: grid navigates via shared list.* vocabulary so rebinds
  // (j/k, home/end, PgUp/PgDn) flow here for free. Flattened row-major
  // segs is the 'list'; setSel maps index ↔ selected id. ←/→ are tab-
  // local aliases since the grid reads 2D but traversal is linear.
  const segs = view.filter(s => s.tokens > 0)
  const idx = selected ? segs.findIndex(s => s.id === selected) : -1
  const setSel: Dispatch<SetStateAction<number>> = (v) => {
    const n = Math.max(0, Math.min(segs.length - 1, typeof v === "function" ? v(idx) : v))
    setSelected(segs[n]?.id ?? null)
  }
  const keys = useKeys()
  useKeyboard((key) => {
    if (!focused || dialog.open()) return
    if (handleListKey(keys, key, {
      count: segs.length, setSel,
      onActivate: () => {
        if (drilled || !selected) return
        const seg = top.find(s => s.id === selected)
        if (seg?.children?.length) { setDrilled(selected); setSelected(null) }
      },
    })) return
    if (key.name === "right") return setSel(p => p + 1)
    if (key.name === "left")  return setSel(p => p - 1)
    if (key.name !== "escape") return
    const now = Date.now()
    if (now - lastEsc.current < 400) {
      setSelected(null); setDrilled(null); lastEsc.current = 0; return
    }
    lastEsc.current = now
    if (selected) return setSelected(null)
    if (drilled) return setDrilled(null)
  })

  const editThreshold = async () => {
    const cur = Math.round((config?.compression?.threshold ?? 0.5) * 100)
    const v = await openTextPrompt(dialog, {
      title: "Compression threshold", label: "Percent (10–95)", initial: String(cur),
    })
    if (v === null) return
    const n = Math.max(10, Math.min(95, Number(v) || cur))
    const { writeConfig } = await import("../config/lane")
    const r = await writeConfig(gw, [{ key: "compression.threshold", to: n / 100 }])
    if (r.failed.length) return toast.show({ variant: "error", message: r.failed[0].err })
    home.invalidate("config")
    toast.show({ variant: "success", message: `Threshold → ${n}%` })
  }

  // Detail panel router
  const detail = () => {
    if (!selected) return null
    const seg = findSeg(selected)
    if (!seg) return null

    // Memory children (accessible when drilled into memory group)
    if (selected === "memory" && drilled === "memory" && memory) {
      return <MemoryPanel seg={seg} theme={theme} label="Agent Notes" chars={memory.charCount} limit={memory.charLimit} pct={memory.usagePercent} entries={memEntries} source={memory.source} />
    }
    if (selected === "user" && userProfile) {
      return <MemoryPanel seg={seg} theme={theme} label="User Profile" chars={userProfile.charCount} limit={userProfile.charLimit} pct={userProfile.usagePercent} entries={userEntries} source={userProfile.source} />
    }
    if (selected === "skills") return <SkillsPanel seg={seg} theme={theme} />
    if (selected === "system_tools" && currentTools) {
      const { system } = classifyTools(currentTools.tools)
      return <ToolsPanel seg={seg} theme={theme} tools={system} kind="system_tools" />
    }
    if (selected === "mcp_tools" && currentTools) {
      const { mcp } = classifyTools(currentTools.tools)
      return <ToolsPanel seg={seg} theme={theme} tools={mcp} kind="mcp_tools" />
    }
    // SOUL drill: prefer the file-backed slice (authoritative read) over
    // the parsed segment from systemPrompt.text.
    if (selected === "soul" && soul) {
      const soulSeg: Segment = {
        ...seg,
        section: {
          id: "soul",
          label: "SOUL.md",
          chars: soul.charCount,
          tokens: soul.tokenEstimate,
          text: soul.content,
          source: soul.source,
        },
      }
      return <SectionPanel seg={soulSeg} theme={theme} />
    }
    if (selected === "conversation") return <ConvPanel seg={seg} theme={theme} messages={messages} output={output} />
    if (selected === "free") return <FreePanel seg={seg} theme={theme} ctxLen={ctxLen} comp={config?.compression} onEditThreshold={editThreshold} />
    return <SectionPanel seg={seg} theme={theme} />
  }

  // Breakdown panel
  const breakdown = () => (
    <box flexDirection="column" marginBottom={1}>
      <text>
        <strong>Breakdown</strong>
        {drilledGroup ? (
          <span fg={theme.info}> · {drilledGroup.label} ({fmt(drilledGroup.tokens)} tok)</span>
        ) : reliable ? (
          <span fg={theme.info}> (click group to expand)</span>
        ) : (
          <span fg={theme.warning}> · live usage unavailable · limit {fmt(ctxLen)}</span>
        )}
      </text>
      {view.filter(s => s.tokens > 0).map(s => (
        <text key={s.id}>
          <span fg={clr(s.id, theme)}>{s.id === "free" ? "◻" : "◼"}</span>{" "}
          {s.label} — {fmt(s.tokens)} ({s.percent.toFixed(1)}%)
          {s.children ? <span fg={theme.textMuted}> ▸</span> : null}
        </text>
      ))}
      {output > 0 && !drilled ? (
        <text><span fg={theme.success}>◼</span> Output — {fmt(output)} tokens</text>
      ) : null}
      {reliable && !drilled ? (
        <text>
          <span fg={theme.textMuted}>◼ Beyond compression threshold ({Math.round(thresholdPct * 100)}%)</span>
        </text>
      ) : null}
    </box>
  )

  const crumb = drilled
    ? `${drilledGroup?.label}${selected ? ` · ${findSeg(selected)?.label}` : ""}`
    : reliable ? "↑↓ nav  ·  click a group to drill in"
    : "live usage unavailable · estimates shown with ~"
  const escHint = selected || drilled ? "  ·  Esc back" : ""

  const focus = selected || hovered
  const focusSeg = focus ? findSeg(focus) : null

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0}>
    <TabShell
      title={reliable ? `Context · ${fmt(used)} / ${fmt(ctxLen)} (${pct}%)` : `Context · live usage unavailable · limit ${fmt(ctxLen)}`}
    >
      <box height={1}>
        {focusSeg ? (
          <text fg={clr(focusSeg.id, theme)}>
            ◼ {focusSeg.label} — {fmt(focusSeg.tokens)} tok ({focusSeg.percent.toFixed(1)}%)
          </text>
        ) : <text>{" "}</text>}
      </box>
      <box height={1} />
      <box flexDirection="row" flexGrow={1}>
        <box flexDirection="column" marginRight={2} flexShrink={0}>
          {/* Compression badge — shown inline above the grid when any
              compression events have fired this session. */}
          {!drilled && compressions > 0 ? (
            <box height={1} marginBottom={1}>
              <text fg={theme.warning}>×{compressions} compressed</text>
            </box>
          ) : null}
          <box border
               customBorderChars={CORNERS}
               borderColor={theme.border}>
            {[...Array(COLS)].map((_, row) => (
              <box key={row} flexDirection="row" height={1}>
                {[...Array(COLS)].map((_, col) => {
                  const cell = grid[row * COLS + col]
                  // Selection wins over hover — otherwise hovering a
                  // different segment lights both groups at once.
                  const hl = selected ? selected === cell.id : hovered === cell.id
                  // Past-threshold cells: ◼ in textMuted; hover still shows category color.
                  const past = !drilled && row * COLS + col >= thresholdIdx
                  const glyph = !past && cell.id === "free" ? "◻" : "◼"
                  return (
                    <box
                      height={1} width={2} key={col}
                      backgroundColor={hl ? clr(cell.id, theme) : undefined}
                      onMouseOver={() => setHovered(cell.id)}
                      onMouseOut={() => setHovered(null)}
                      onMouseDown={() => click(cell.id)}
                    >
                      <text fg={past ? theme.textMuted : clr(cell.id, theme)}>
                        {glyph}
                      </text>
                    </box>
                  )
                })}
              </box>
            ))}
          </box>
        </box>

        <box flexDirection="column" flexGrow={1} minWidth={0}>
          {selected ? detail() : breakdown()}
        </box>
      </box>
    </TabShell>
    <HintBar raw={crumb + escHint} />
    </box>
  )
})
