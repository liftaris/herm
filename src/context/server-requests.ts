import type { PromptReq, PromptPart } from "../types/message"

export type ServerRequest = { id: string; method: string; params: Record<string, unknown> }

function strings(raw: unknown): string[] | undefined {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : undefined
}

export function prompt(raw: unknown): PromptReq | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const frame = raw as Record<string, unknown>
  if (typeof frame.id !== "string" || typeof frame.method !== "string" || !frame.params || typeof frame.params !== "object" || Array.isArray(frame.params)) return null
  const p = frame.params as Record<string, unknown>
  if (typeof p.session_id !== "string") return null
  const base = { id: frame.id, session_id: p.session_id }
  if (frame.method === "approval" && typeof p.request_id === "string") return {
    ...base, variant: "approval", request_id: p.request_id,
    command: typeof p.command === "string" ? p.command : "",
    description: typeof p.description === "string" ? p.description : "",
    choices: strings(p.choices), pattern_keys: strings(p.pattern_keys),
    allow_permanent: p.allow_permanent !== false, allow_session: p.allow_session !== false,
  }
  if (frame.method === "sudo") return { ...base, variant: "sudo", command: typeof p.command === "string" ? p.command : "" }
  if (frame.method === "secret" && typeof p.env_var === "string" && typeof p.prompt === "string")
    return { ...base, variant: "secret", env_var: p.env_var, prompt: p.prompt }
  if (frame.method !== "clarify" || !Array.isArray(p.questions)) return null
  const questions = p.questions.flatMap(raw => {
    if (!raw || typeof raw !== "object") return []
    const q = raw as Record<string, unknown>
    if (typeof q.qid !== "string" || !q.qid || typeof q.question !== "string" || !q.question.trim()) return []
    return [{ qid: q.qid, question: q.question, choices: strings(q.choices) ?? null, multi_select: q.multi_select === true }]
  })
  if (!questions.length) return null
  const answers = p.answers && typeof p.answers === "object"
    ? Object.fromEntries(Object.entries(p.answers).filter((v): v is [string, string | null] => v[1] === null || typeof v[1] === "string"))
    : undefined
  return { ...base, variant: "clarify", questions, answers }
}

export function parts(requests: ServerRequest[] = []): PromptPart[] {
  return requests.flatMap(raw => {
    const req = prompt(raw)
    return req ? [{ type: "prompt", id: req.id, variant: req.variant, req }] : []
  })
}
