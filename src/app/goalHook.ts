// Goal-completion reactor. Polls state_meta['goal:<sid>'] after each
// turn and, on transition to status=done, performs the onGoalDone
// pref action. The judge that *writes* that status and the
// continuation loop itself live in stock tui_gateway/server.py (post-
// turn Ralph hook in _run_prompt_submit); setting/controlling the
// goal goes through the standard slash.exec → command.dispatch
// fallback in app.tsx's slash() — tui_gateway rejects /goal from the
// slash-worker (_PENDING_INPUT_COMMANDS) and command.dispatch's
// handler drives GoalManager directly, including returning
// {type:"send", notice, message: goal} on set so herm renders the
// notice and submits the kickoff prompt. Nothing to do here except
// react to completion.

import type { DialogContext } from "../ui/dialog"
import { prefs } from "../context/preferences"
import { openCountdown } from "../dialogs/countdown"
import { io } from "../io"

type Toast = { show: (o: { variant: "success" | "error"; title?: string; message: string; duration?: number }) => void }

export type GoalHook = {
  /** Called from onTurnComplete. Reads goal state, fires if done. */
  check: (sid: string) => void
}

const SECONDS = 10
const SUSPEND = process.platform === "darwin" ? "pmset sleepnow" : "systemctl suspend"

const run = (cmd: string) =>
  Bun.spawn(["sh", "-c", cmd], { stdout: "ignore", stderr: "ignore" })

// Latch per sid+goal so repeated done-polls don't re-fire. Module
// scope — switching sessions naturally keys out of it, and profile
// switch calls rehome() which starts a fresh sid anyway.
const fired = new Map<string, string>()

export function makeGoalHook(dialog: DialogContext, toast: Toast): GoalHook {
  const act = (goal: string, done?: number, total?: number) => {
    const pref = (prefs.get("onGoalDone") ?? "toast").trim()
    const head = goal.length > 60 ? goal.slice(0, 57) + "…" : goal
    const n = total && total > 0 ? `  ${done}/${total} items` : ""
    toast.show({
      variant: "success", title: "Goal complete", message: head + n, duration: 8000,
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
        const list = s.checklist ?? []
        const done = list.filter(i => i.status === "completed" || i.status === "impossible").length
        act(s.goal, done, list.length)
      }).catch(err => toast.show({ variant: "error", message: err instanceof Error ? err.message : String(err) }))
    },
  }
}
