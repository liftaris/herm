// Which RPC methods accept a `session_id` param.
//
// The gateway's Params models are `extra="forbid"`: sending `session_id` to a
// method that does not declare it answers 4000 "Extra inputs are not permitted"
// instead of being ignored, which takes the whole call down. Injecting the
// active session into every request therefore breaks every method outside this
// set — /journey (learning.frames/details/edit/delete) is the common hit.
//
// Derived from the Hermes contracts (`tui_gateway/contracts/*.py`): a method is
// listed here when its Params model, or any base it inherits, declares
// `session_id`. Regenerate against a backend bump rather than editing by hand.
//
// Provenance: hermes-agent@6e69a8933a (237 methods; 82 declare session_id).

const SCOPED = new Set([
  "approval.pending",
  "approval.received",
  "approval.respond",
  "billing.step_up",
  "browser.controller.detach",
  "browser.controller.heartbeat",
  "browser.controller.register",
  "browser.controller.result",
  "browser.manage",
  "clipboard.paste",
  "command.dispatch",
  "commands.catalog",
  "complete.path",
  "complete.slash",
  "config.get",
  "config.set",
  "file.attach",
  "handoff.fail",
  "handoff.request",
  "handoff.state",
  "image.attach",
  "image.attach_bytes",
  "image.detach",
  "input.detect_drop",
  "llm.oneshot",
  "mcp.servers.oauth.callback",
  "mcp.servers.oauth.cancel",
  "mcp.servers.oauth.poll",
  "message.react",
  "model.disconnect",
  "model.options",
  "model.save_key",
  "pdf.attach",
  "preview.restart",
  "process.kill",
  "process.list",
  "process.stop",
  "prompt.background",
  "prompt.btw",
  "prompt.submit",
  "reload.mcp",
  "rollback.diff",
  "rollback.list",
  "rollback.restore",
  "session.activate",
  "session.branch",
  "session.branch_whole",
  "session.close",
  "session.compress",
  "session.context_breakdown",
  "session.control",
  "session.control.read",
  "session.cwd.set",
  "session.delete",
  "session.events.since",
  "session.history",
  "session.interrupt",
  "session.redirect",
  "session.resume",
  "session.save",
  "session.set_hidden",
  "session.status",
  "session.steer",
  "session.title",
  "session.undo",
  "session.usage",
  "skills.reload",
  "slash.exec",
  "spawn_tree.list",
  "spawn_tree.save",
  "subagent.interrupt",
  "subagent.list",
  "subagent.steer",
  "subagent.tail",
  "terminal.resize",
  "tools.configure",
  "tools.list",
  "tools.show",
  "toolsets.list",
  "verification.status",
  "voice.record",
  "wake.start",
])

export function scoped(method: string): boolean {
  return SCOPED.has(method)
}

export function merge(method: string, sid: string, params: Record<string, unknown>): Record<string, unknown> {
  if (!sid || !scoped(method) || params.session_id !== undefined) return params
  return { session_id: sid, ...params }
}

export * as sessionScope from "./session-scope"
