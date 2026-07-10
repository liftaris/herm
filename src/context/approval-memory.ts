import * as prefs from "./preferences"
import type { NeverPrompt } from "./preferences"
import type { PromptReq } from "../types/message"

export type ApprovalReq = Extract<PromptReq, { variant: "approval" }>
export type ApprovalPrompt = ApprovalReq & {
  group: string
  question: string
  subject: string
}

const group = "approval"

function question(req: ApprovalReq): string {
  return (req.description || "Shell command").trim()
}

function subject(req: ApprovalReq): string {
  if (req.pattern_keys?.length) return req.pattern_keys.join("|")
  return req.command.trim()
}

export function mkApproval(req: ApprovalReq): ApprovalPrompt {
  return { ...req, group, question: question(req), subject: subject(req) }
}

export function shouldRemember(req: ApprovalReq): boolean {
  const cur: NeverPrompt[] = prefs.get("neverPrompts") ?? []
  const p = mkApproval(req)
  return cur.some(x => x.group === p.group && x.question === p.question && x.subject === p.subject)
}

export function remember(req: ApprovalReq): void {
  const cur: NeverPrompt[] = prefs.get("neverPrompts") ?? []
  const p = mkApproval(req)
  if (cur.some(x => x.group === p.group && x.question === p.question && x.subject === p.subject)) return
  prefs.set("neverPrompts", [...cur, { group: p.group, question: p.question, subject: p.subject }])
}
