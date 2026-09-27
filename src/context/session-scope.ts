// Whether an RPC method accepts a `session_id` param, and the merge that
// applies one.
//
// The gateway's Params models are `extra="forbid"`: sending `session_id` to a
// method that does not declare it answers 4000 "Extra inputs are not
// permitted" instead of being ignored, which takes the whole call down.
// Injecting the active session into every request therefore breaks every
// method outside the session-scoped set — /journey (learning.frames and
// friends) and the Skills tab (skills.manage) are the visible casualties.
//
// The set itself is GENERATED from the Hermes contracts, not hand-maintained:
// see src/context/session-scope.gen.ts and `bun run gen-session-scope`.

import { SESSION_SCOPED } from "./session-scope.gen"

const SCOPED = new Set(SESSION_SCOPED)

export function scoped(method: string): boolean {
  return SCOPED.has(method)
}

export function merge(method: string, sid: string, params: Record<string, unknown>): Record<string, unknown> {
  if (!sid || !scoped(method) || params.session_id !== undefined) return params
  return { session_id: sid, ...params }
}

export * as sessionScope from "./session-scope"
