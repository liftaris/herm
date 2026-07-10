// Message types for herm chat — parts-based like OpenCode

export type TextPart = {
  type: "text"
  key?: string
  content: string
  streaming: boolean
}

export type ToolPart = {
  type: "tool"
  id: string
  name: string
  args: string
  status: "running" | "done" | "error"
  startedAt?: number
  duration?: number
  preview?: string
  /** Redacted verbose args from gateway tool.start.args_text, when /verbose verbose is active. */
  verboseArgs?: string
  /** Redacted verbose result from gateway tool.complete.result_text, when /verbose verbose is active. */
  verboseResult?: string
  result?: string
  diff?: string
  /** Subagent only — child tool calls accumulated from subagent.tool events. */
  trail?: Array<{ name: string; preview?: string }>
  /** Subagent only — goal text from subagent.start. */
  goal?: string
  /** Subagent only — spawn depth, 0 = direct child of the main agent. */
  depth?: number
}

export type ThinkingPart = {
  type: "thinking"
  key?: string
  content: string
  streaming: boolean
  verbose?: boolean
}

/** Agent-originated interactive prompt. Renders inline in the
 *  transcript; `answered` is set (in place) once the user responds,
 *  collapsing the card to a one-line outcome row that persists in
 *  history. */
export type PromptPart = {
  type: "prompt"
  id: string
  variant: "approval" | "clarify" | "sudo" | "secret"
  req: PromptReq
  answered?: { label: string; ok: boolean; at: number; question?: string }
}

export type PromptReq =
  | { variant: "approval"; command: string; description: string; pattern_keys?: string[] }
  | { variant: "clarify"; request_id: string; question: string; choices: string[] | null }
  | { variant: "sudo"; request_id: string }
  | { variant: "secret"; request_id: string; prompt: string; env_var: string }

export type Part = TextPart | ToolPart | ThinkingPart | PromptPart

export type Usage = {
  input: number
  output: number
  total: number
  active_subagents?: number
  // Context-compression fields — populated when the agent has a
  // ContextCompressor attached (default). Absent on sessions without
  // compression, so consumers must guard with `typeof x === "number"`.
  context_used?: number
  context_max?: number
  context_percent?: number
  compressions?: number
}

export type Message = {
  id: string
  role: "user" | "assistant" | "system"
  parts: Part[]
  timestamp: number
  speaker?: string
  model?: string
  duration?: number
  usage?: Usage
  error?: string
}

// Helper to extract all text content from a message
export function text(msg: Message): string {
  return msg.parts
    .filter((p): p is TextPart => p.type === "text")
    .map(p => p.content)
    .join("")
}

// Create a unique message ID
export function mid(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

let pn = 0
/** Stable per-part key so React doesn't remount when parts shift index. */
export function pid(): string {
  return `p${++pn}`
}
