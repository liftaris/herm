// Typed events and RPC responses for the tui_gateway JSON-RPC protocol.

import type { Usage } from "../types/message"

export type NotificationShowPayload = {
  text: string
  level?: "info" | "warning" | "warn" | "error" | "success" | string
  kind?: "sticky" | "toast" | "transient" | string
  key?: string
  ttl_ms?: number
  duration_ms?: number
}

export type NotificationClearPayload = {
  key?: string
}

export type GatewayEvent = ({
  session_id?: string
} & (
  | { type: "gateway.ready"; payload?: { skin?: GatewaySkin } }
  | { type: "gateway.stderr"; payload: { line: string } }
  | { type: "gateway.start_timeout"; payload?: { cwd?: string; python?: string } }
  | { type: "gateway.protocol_error"; payload?: { preview?: string } }
  | { type: "session.info"; payload: SessionInfo }
  | { type: "session.title"; payload: { session_id?: string; title?: string } }
  | { type: "skin.changed"; payload?: GatewaySkin }
  | { type: "message.start"; payload?: undefined }
  | { type: "message.delta"; payload?: { text?: string; rendered?: string } }
  | { type: "message.complete"; payload?: { text?: string | null; rendered?: string; reasoning?: string; status?: "complete" | "error" | "interrupted"; usage?: Usage } }
  | { type: "thinking.delta"; payload?: { text?: string } }
  | { type: "reasoning.delta"; payload?: { text?: string; verbose?: boolean } }
  | { type: "reasoning.available"; payload?: { text?: string; verbose?: boolean } }
  | { type: "moa.reference"; payload?: { label?: string; text?: string; index?: number; count?: number } }
  | { type: "moa.aggregating"; payload?: { aggregator?: string } }
  | { type: "status.update"; payload?: { text?: string; kind?: string } }
  | { type: "notification.show"; payload?: NotificationShowPayload }
  | { type: "notification.clear"; payload?: NotificationClearPayload }
  | { type: "tool.start"; payload: { tool_id: string; name?: string; context?: string; args_text?: string; todos?: unknown[] } }
  | { type: "tool.progress"; payload: { name?: string; preview?: string } }
  | { type: "tool.generating"; payload: { name?: string } }
  | { type: "tool.complete"; payload: { tool_id: string; name?: string; summary?: string; error?: string; inline_diff?: string; duration_s?: number; result_text?: string; todos?: unknown[] } }
  | { type: "clarify.request"; payload: { request_id: string; question: string; choices: string[] | null } }
  | { type: "approval.request"; payload: { command: string; description: string; pattern_keys?: string[] } }
  | { type: "sudo.request"; payload: { request_id: string } }
  | { type: "secret.request"; payload: { request_id: string; prompt: string; env_var: string } }
  | { type: "background.complete"; payload: { task_id: string; text: string } }
  | { type: "review.summary"; payload?: { text?: string } }
  | { type: "btw.complete"; payload: { text: string } }
  | { type: "browser.progress"; payload?: { message?: string; level?: "info" | "error" } }
  | { type: "voice.status"; payload?: { state?: "idle" | "listening" | "transcribing" } }
  | { type: "voice.transcript"; payload?: { text?: string; no_speech_limit?: boolean } }
  | { type: "subagent.start"; payload: SubagentPayload }
  | { type: "subagent.thinking"; payload: SubagentPayload }
  | { type: "subagent.tool"; payload: SubagentPayload }
  | { type: "subagent.progress"; payload: SubagentPayload }
  | { type: "subagent.complete"; payload: SubagentPayload }
  | { type: "error"; payload?: { message?: string } }
))

export type SubagentPayload = {
  task_index: number
  goal: string
  task_count?: number
  status?: "completed" | "error" | "failed" | "interrupted" | "queued" | "running" | "timeout"
  text?: string
  tool_name?: string
  tool_preview?: string
  summary?: string
  duration_seconds?: number
  // Spawn-tree identity (upstream delegate_tool threads these through
  // every subagent.* event). All optional — absence falls back to flat
  // task_index keying.
  subagent_id?: string
  parent_id?: string
  depth?: number
  model?: string
  tool_count?: number
  toolsets?: string[]
  // Rollups on subagent.complete
  input_tokens?: number
  output_tokens?: number
  reasoning_tokens?: number
  api_calls?: number
  cost_usd?: number
  files_read?: string[]
  files_written?: string[]
  output_tail?: Array<{ tool: string; preview: string; is_error?: boolean }>
}

// delegation.status response — list_active_subagents() snapshot plus
// scheduler flags. Records are a copy of the live registry minus the
// agent handle.
export type DelegationRecord = {
  subagent_id: string
  parent_id?: string | null
  depth: number
  goal: string
  model?: string
  started_at?: number
  tool_count?: number
  status?: string
}

export type DelegationStatus = {
  active: DelegationRecord[]
  paused: boolean
  max_spawn_depth: number
  max_concurrent_children: number
}

// spawn_tree.list index entries + spawn_tree.load payload
export type SpawnTreeEntry = {
  path: string
  session_id: string
  label: string
  count: number
  started_at?: number | null
  finished_at: number
}

export type SpawnTreeSnapshot = {
  session_id?: string
  label?: string
  started_at?: number | null
  finished_at?: number
  subagents: SpawnSubagent[]
}

// Persisted per-subagent record — the shape we save, and the shape
// spawn_tree.load round-trips. A completed SubagentPayload superset.
export type SpawnSubagent = {
  subagent_id: string
  parent_id?: string | null
  depth: number
  goal: string
  model?: string
  started_at: number
  finished_at?: number
  tool_count: number
  status: "completed" | "error" | "failed" | "interrupted" | "queued" | "running" | "timeout"
  input_tokens?: number
  output_tokens?: number
  cost_usd?: number
  trail?: Array<{ name: string; preview?: string }>
}

export type GatewaySkin = {
  name?: string
  colors?: Record<string, string>
  branding?: Record<string, string>
  banner_hero?: string
  banner_logo?: string
  tool_prefix?: string
  help_header?: string
}

export type McpServer = {
  name: string
  transport: string
  tools: number
  connected: boolean
  error?: string
}

export type SessionInfo = {
  model?: string
  cwd?: string
  session_id?: string
  stored_session_id?: string
  /**
   * Live tool catalog from gateway session.info. state.db is canonical for
   * historical sessions, while legacy sessions/session_*.json snapshots are
   * optional debug files; current tool counts should come from this wire
   * payload when available.
   */
  tools?: Record<string, string[]>
  skills?: Record<string, string[]>
  version?: string
  /**
   * Live active-agent system prompt from `agent._cached_system_prompt`
   * (gateway `_session_info`, tui_gateway/server.py). Prefer this over
   * `readSystemPromptInfo()`'s state.db scan — the DB row is per-session
   * and only written at turn boundaries, while this reflects the current
   * prompt including mid-session personality/skin switches. Optional
   * because older gateways don't send it.
   */
  system_prompt?: string
  /**
   * Wire usage payload for the current session. Server builds this via
   * `_get_usage(agent)` (tui_gateway/server.py:826), which extends the
   * base Usage with ctx/compression fields when a ContextCompressor is
   * attached — so `compressions`/`context_used`/`context_max`/
   * `context_percent` may be present. Intersection type keeps both
   * shapes satisfied.
   */
  usage?: Usage & {
    context_used?: number
    context_max?: number
    context_percent?: number
    compressions?: number
  }
  context_max?: number
  context_used?: number
  credential_warning?: string
  install_warning?: string
  running?: boolean
  yolo?: boolean
  mcp_servers?: McpServer[]
  /** hermes-agent version string (e.g. "1.14.2-dev+abc123") */
  release_date?: string
  /** commits behind origin/main; null = unknown, negative = update available with unknown count */
  update_behind?: number | null
  /** platform-appropriate update invocation */
  update_command?: string
  /** Live session title from gateway (avoids redundant session.title RPC) */
  title?: string
}

export type SessionCreateResponse = {
  session_id: string
  stored_session_id?: string
  info?: SessionInfo & { credential_warning?: string }
}

export type SessionResumeResponse = {
  session_id: string
  resumed?: string
  session_key?: string
  messages: TranscriptMessage[]
  message_count?: number
  info?: SessionInfo
}

export type LiveSessionStatus = "idle" | "starting" | "waiting" | "working"

export type SessionActiveItem = {
  id: string
  session_key?: string
  title?: string
  preview?: string
  model?: string
  status: LiveSessionStatus
  current?: boolean
  message_count?: number
  started_at?: number
  last_active?: number
}

export type SessionActiveListResponse = {
  sessions?: SessionActiveItem[]
}

export type SessionInflightTurn = {
  user?: string
  assistant?: string
  streaming?: boolean
}

export type SessionActivateResponse = {
  session_id: string
  session_key?: string
  messages: TranscriptMessage[]
  message_count?: number
  info?: SessionInfo
  running?: boolean
  status?: LiveSessionStatus
  started_at?: number
  inflight?: SessionInflightTurn | null
}

export type SessionListItem = {
  id: string
  title: string
  preview: string
  message_count: number
  started_at: number
  source?: string
}

export type SessionListResponse = {
  sessions?: SessionListItem[]
}

export type SessionUsageResponse = {
  model?: string
  calls?: number
  credits_lines?: string[]
  dev_credits_spent_micros?: number
  input?: number
  output?: number
  total?: number
  cache_read?: number
  cache_write?: number
  reasoning?: number
  active_subagents?: number
  cost_usd?: number
  cost_status?: "estimated" | "exact"
  context_used?: number
  context_max?: number
  context_percent?: number
  compressions?: number
}

export type ContextUsageCategory = {
  color?: string
  id: string
  label: string
  tokens: number
}

export type ContextBreakdownResponse = {
  categories: ContextUsageCategory[]
  context_max: number
  context_percent: number
  context_used: number
  estimated_total: number
  model?: string
}

/** Content part inside a multimodal user turn — upstream stores the raw
 *  OpenAI content list for native-mode image routing. We only care about
 *  flattening the text fragments back into a string for render. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: string }

export type TranscriptMessage = {
  role: "user" | "assistant" | "system" | "tool"
  /** Either a plain string (text-mode, assistant, system) or a list of
   *  OpenAI content parts (native-mode user turns with attached images). */
  text?: string | ContentPart[]
  name?: string
  context?: string
}

export type CommandsCatalogResponse = {
  categories?: Array<{ name: string; pairs?: [string, string][] }>
  pairs?: [string, string][]
  canon?: Record<string, string>
  sub?: Record<string, string[]>
  skill_count?: number
  warning?: string
}

export type LearningRun = [text: string, style: string, alpha?: number, hexOverride?: string | null]

export type LearningLabel = {
  key: string
  glyph: string
  label: string
  meta: string
  style: string
  alpha: number
}

export type LearningLegend = {
  glyph: string
  style?: string
  color?: string
  label: string
}

export type LearningNode = {
  id: string
  glyph: string
  label: string
  fullLabel?: string
  meta: string
  body?: string
  style: string
}

export type LearningBucket = {
  index: number
  label: string
  date: string
  skills: number
  memories: number
  total: number
  category: string | null
  color: string | null
  nodes: LearningNode[]
}

export type LearningFramesRequest = {
  cols?: number
  rows?: number
  frames?: number
}

export type LearningFramesResponse = {
  frames: Array<{
    reveal: number
    date: string
    visible: number
    grid: LearningRun[][]
    labels: LearningLabel[]
  }>
  legend: LearningLegend[]
  categories?: LearningLegend[]
  buckets?: LearningBucket[]
  summary: string[]
  axis: { start: string; end: string }
  count: number
  cols: number
  rows: number
}

export type LearningDetailRequest = { id: string }

export type LearningDetailResponse =
  | { ok: true; kind: "memory" | "skill"; id: string; label: string; content: string }
  | { ok: false; message: string }

export type LearningEditRequest = { id: string; content: string }
export type LearningDeleteRequest = { id: string }

export type LearningMutationResponse = { ok: boolean; message: string }

export type ConfigSetResponse = {
  value?: string
  info?: SessionInfo
  warning?: string
  history_reset?: boolean
}

export type ModelPricing = {
  input: string
  output: string
  cache: string | null
  free: boolean
}

export type ModelCapabilities = {
  fast?: boolean
  reasoning?: boolean
}

export type ModelOptionProvider = {
  slug: string
  name: string
  models?: string[]
  total_models?: number
  is_current?: boolean
  warning?: string
  authenticated?: boolean
  auth_type?: string
  key_env?: string
  pricing?: Record<string, ModelPricing>
  free_tier?: boolean
  unavailable_models?: string[]
  capabilities?: Record<string, ModelCapabilities>
}

export type ModelOptionsResponse = {
  provider?: string
  model?: string
  providers?: ModelOptionProvider[]
}

export type ImageAttachResponse = {
  attached: boolean
  path?: string
  count?: number
  name?: string
  width?: number
  height?: number
  token_estimate?: number
  message?: string
}

export type ImageDetachRequest = { path: string }

export type ImageDetachResponse = {
  detached: boolean
  count: number
}

export type DropDetectResponse =
  | { matched: false }
  | ({ matched: true; is_image: true; text: string } & Omit<ImageAttachResponse, "attached" | "message">)
  | { matched: true; is_image: false; path: string; name: string; text: string }
