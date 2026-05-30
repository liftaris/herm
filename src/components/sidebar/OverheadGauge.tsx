import { memo } from "react"
import { useTheme } from "../../theme"
import type { SessionInfo } from "../../context/wire"
import type { Usage } from "../../types/message"
import { formatTokens } from "../../utils/tokens"

// Overhead breakdown — stacked bar showing per-turn context cost.
// Estimates each component from the system prompt content and tool/skill counts.
// System prompt is a single string; we estimate sub-components by known sizes.

const FILL = "█"
const EMPTY = "░"
const CHAR_TO_TOKEN = 0.25
const TOOL_TOKENS = 125
const SKILL_TOKENS = 20
// Known component sizes (chars) from the system prompt assembly.
// These are stable across sessions — measured once from the actual prompt.
const KNOWN = {
  agent_guidance: 2000,   // task completion, no-fabrication, hermes-agent pointer
  tool_guidance:  1200,   // memory, session_search, skills, kanban guidance
  model_guidance:  500,   // Gemini, GPT/Grok operational guidance
  env_profile:     800,   // environment hints, probe, profile, platform
  timestamp:       200,   // date, session ID, model, provider
} as const

const estimate = (info?: SessionInfo | null) => {
  if (!info) return { identity: 0, context: 0, skills: 0, memory: 0, tools: 0, guidance: 0 }

  // Identity: SOUL.md (~866 chars) + agent guidance (~2000 chars)
  const identity = Math.round((866 + KNOWN.agent_guidance) * CHAR_TO_TOKEN)

  // Context files: AGENTS.md + .cursorrules + project SOUL.md
  // Subtract known sizes from total system prompt to estimate context files
  const totalPrompt = info.system_prompt ? info.system_prompt.length : 0
  const knownStable = 866 + KNOWN.agent_guidance + KNOWN.tool_guidance + KNOWN.model_guidance + KNOWN.env_profile + KNOWN.timestamp
  const context = Math.round(Math.max(0, totalPrompt - knownStable) * CHAR_TO_TOKEN)

  // Skills: count from info.skills
  const sc = Object.values(info.skills ?? {}).reduce((n, v) => n + v.length, 0)
  const skills = sc * SKILL_TOKENS

  // Memory: MEMORY.md + USER.md + external provider (estimated from prompt)
  // We can't parse this out of the system prompt, so estimate ~500 tokens if memory is active
  const memory = 500

  // Tool schemas: count from info.tools
  const tc = Object.values(info.tools ?? {}).reduce((n, v) => n + v.length, 0)
  const tools = tc * TOOL_TOKENS

  // Guidance: tool-specific + model-specific + env/profile/platform
  const guidance = Math.round((KNOWN.tool_guidance + KNOWN.model_guidance + KNOWN.env_profile) * CHAR_TO_TOKEN)

  return { identity, context, skills, memory, tools, guidance }
}

const pad = (s: string, w: number) => {
  const p = Math.max(0, w - s.length)
  const l = Math.ceil(p / 2)
  return " ".repeat(l) + s + " ".repeat(p - l)
}

export const OverheadGauge = memo((props: {
  info?: SessionInfo | null
  usage?: Usage
  width: number
}) => {
  const theme = useTheme().theme
  const { identity, context, skills, memory, tools, guidance } = estimate(props.info)
  const total = identity + context + skills + memory + tools + guidance
  if (total <= 0) return null

  const cells = Math.max(8, props.width - 2)
  const scale = (t: number) => Math.round((t / total) * cells)
  const segs = [
    { label: "Identity", tok: identity, color: theme.primary, w: scale(identity) },
    { label: "Context", tok: context, color: theme.success, w: scale(context) },
    { label: "Skills", tok: skills, color: theme.warning, w: scale(skills) },
    { label: "Memory", tok: memory, color: theme.error, w: scale(memory) },
    { label: "Tools", tok: tools, color: theme.secondary, w: scale(tools) },
    { label: "Guidance", tok: guidance, color: theme.textMuted, w: scale(guidance) },
  ].filter(s => s.w > 0)

  const usedW = segs.reduce((n, s) => n + s.w, 0)
  const emptyW = Math.max(0, cells - usedW)

  const max = props.usage?.context_max ?? props.info?.usage?.context_max ?? props.info?.context_max
  const pct = max ? ((total / max) * 100) : 0
  const pctS = pct < 10 ? pct.toFixed(1) : String(Math.round(pct))

  return (
    <box flexDirection="column" marginTop={1}>
      <box height={1}>
        <text>
          <span fg={theme.textMuted}>{" "}</span>
          <span fg={theme.text}>Overhead</span>
          <span fg={theme.textMuted}>{` ${formatTokens(total)} (${pctS}%)`}</span>
        </text>
      </box>
      <box height={1}>
        <text>
          <span fg={theme.textMuted}>[</span>
          {segs.map((s, i) => <span key={i} fg={s.color}>{FILL.repeat(s.w)}</span>)}
          <span fg={theme.textMuted}>{EMPTY.repeat(emptyW)}]</span>
        </text>
      </box>
      {/* Legend — 2 rows of 3 */}
      {[0, 3].map(row => (
        <box key={row} height={1}>
          <text>
            {segs.slice(row, row + 3).map((s, j) => (
              <span key={j}>
                {j > 0 ? <span fg={theme.textMuted}>{"  "}</span> : null}
                <span fg={s.color}>■</span>
                <span fg={theme.textMuted}>{` ${s.label} ${formatTokens(s.tok)}`}</span>
              </span>
            ))}
          </text>
        </box>
      ))}
    </box>
  )
})
