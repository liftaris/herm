// Goal-completion hook. Polls state_meta['goal:<sid>'] after each turn
// and, on transition to status=done, performs the onGoalDone pref
// action. The judge that *writes* that status lives in stock
// tui_gateway/server.py (the post-turn Ralph loop); this module is the
// reactor, not the driver.
//
// Setting/controlling the goal goes through command.dispatch, NOT the
// slash-worker. HermesCLI._handle_goal_command queues the kickoff prompt
// onto an in-process _pending_input queue that a slash-worker subprocess
// cannot read, so tui_gateway handles /goal directly and returns a typed
// {type: "send", notice, message} payload.

import type { DialogContext } from "../ui/dialog"
import type { Gateway } from "./gateway"
import * as prefs from "../utils/preferences"
import { openCountdown } from "../dialogs/countdown"
import { io } from "../io"

type Toast = { show: (o: { variant: "success"; title?: string; message: string; duration?: number }) => void }
type ShellResult = { stdout: string; stderr: string; code: number }
type DispatchResult = { type?: string; output?: string; notice?: string; message?: string }

export type GoalHook = {
  /** Called from onTurnComplete. Reads goal state, fires if done. */
  check: (sid: string) => void
  /** Route /goal through command.dispatch. Returns cleaned output for
   *  the transcript plus an optional kickoff prompt from the gateway
   *  ({type: "send", message}) when setting a fresh goal. */
  cmd: (arg: string, sid?: string) => Promise<{ line: string; kick: string | null }>
}

const SECONDS = 10
const SUSPEND = process.platform === "darwin" ? "pmset sleepnow" : "systemctl suspend"
// _handle_goal_command prints via _cprint with _DIM/_RST interpolated
// into the string before the worker's lambda swap, so the ANSI bytes
// are in the captured buffer. Strip them for the transcript.
const ANSI = /\x1b\[[0-9;]*m/g

const run = (cmd: string) =>
  Bun.spawn(["sh", "-c", cmd], { stdout: "ignore", stderr: "ignore" })

// Latch per sid+goal so repeated done-polls don't re-fire. Module
// scope — switching sessions naturally keys out of it, and profile
// switch calls rehome() which starts a fresh sid anyway.
const fired = new Map<string, string>()

export function makeGoalHook(gw: Gateway, dialog: DialogContext, toast: Toast): GoalHook {
  const act = (goal: string) => {
    const pref = (prefs.get("onGoalDone") ?? "toast").trim()
    const head = goal.length > 60 ? goal.slice(0, 57) + "…" : goal
    toast.show({
      variant: "success", title: "Goal complete", message: head, duration: 8000,
    })
    if (pref === "toast") return
    const cmd = pref === "suspend" ? SUSPEND : pref
    void openCountdown(dialog, {
      title: "Goal complete — " + (pref === "suspend" ? "suspending" : "running hook"),
      body: head,
      action: `→ ${cmd}`,
      seconds: SECONDS,
    }).then(ok => { if (ok) run(cmd) })
  }

  return {
    check: (sid: string) => {
      if (!sid) return
      void io.goalState(sid).then(s => {
        if (!s || s.status !== "done") return
        if (fired.get(sid) === s.goal) return
        fired.set(sid, s.goal)
        act(s.goal)
      }).catch(() => {})
    },
    cmd: async (arg: string, sid?: string) => {
      const trimmed = arg.trim()
      const r = await gw.request<DispatchResult>("command.dispatch",
        { name: "goal", arg: trimmed, ...(sid ? { session_id: sid } : {}) })
      const line = (r.notice ?? r.output ?? "").replace(ANSI, "").trim() || "ok"
      const kick = r.type === "send" && r.message ? r.message : null
      return { line, kick }
    },
  }
}

// Exposed for tests — keep type surface minimal.
export type { ShellResult }
