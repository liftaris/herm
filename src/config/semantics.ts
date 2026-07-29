import { TOOL_PROGRESS } from "./lane"
import { APPROVAL_MODES } from "./schema"

export const SELECTS: Record<string, readonly string[]> = {
  "terminal.backend": ["local", "docker", "ssh", "modal", "daytona", "singularity", "vercel_sandbox"],
  "tts.provider": ["edge", "elevenlabs", "openai", "neutts", "xai", "mistral"],
  "logging.level": ["DEBUG", "INFO", "WARNING", "ERROR"],
  "agent.reasoning_effort": ["", "none", "minimal", "low", "medium", "high", "xhigh"],
  "agent.verify_on_stop": ["auto", "true", "false"],
  "display.busy_input_mode": ["queue", "steer", "interrupt"],
  "display.details_mode": ["hidden", "collapsed", "expanded"],
  "display.thinking_mode": ["collapsed", "truncated", "full"],
  "display.tool_progress": [...TOOL_PROGRESS],
  "approvals.mode": [...APPROVAL_MODES],
  "onboarding.profile_build": ["ask", "off"],
  "streaming.transport": ["auto", "draft", "edit", "off"],
  "tools.tool_search.enabled": ["auto", "on", "off"],
  "updates.non_interactive_local_changes": ["stash", "discard"],
}

export const MERGE: Record<string, string> = {
  approvals: "security", privacy: "security", secrets: "security",
  checkpoints: "agent", context: "agent", cron: "agent", network: "agent",
  model_catalog: "general", onboarding: "general",
  human_delay: "display", dashboard: "display", gateway: "display",
  desktop: "display", voice: "display",
  tool_output: "agent", prompt_caching: "compression", code_execution: "terminal",
  computer_use: "agent", goals: "agent", lsp: "agent", tool_loop_guardrails: "agent",
  web: "agent", x_search: "agent", tools: "agent", streaming: "display",
  vertex: "general",
  slack: "platforms", telegram: "platforms", mattermost: "platforms",
  discord: "platforms", whatsapp: "platforms", matrix: "platforms",
}
