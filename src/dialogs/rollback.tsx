// Checkpoint rollback browser — list git-style checkpoints the gateway
// has captured, preview a unified diff, and restore on confirm.
//
// State lives entirely inside <RollbackDialog>; the global dialog
// provider closes on Esc, so when we want Esc to mean "back to list"
// from the diff view we immediately re-replace() ourselves with the
// already-loaded data (our key handler registers after the provider's,
// so our replace wins the batched setState race).

import { useEffect, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { useKeys, handleListKey } from "../keys"
import { useTheme } from "../theme"
import type { DialogContext } from "../ui/dialog"
import type { useToast } from "../ui/toast"
import type { Gateway } from "../context/gateway"
import { DiffBlock } from "../components/chat/DiffBlock"
import { ago, trunc } from "../ui/fmt"

type Toast = ReturnType<typeof useToast>

type Checkpoint = { hash: string; timestamp: number; message: string }
type ListRes = { enabled: boolean; checkpoints: Checkpoint[]; err?: string }
type DiffRes = { stat: string; diff: string; rendered?: string }
type RestoreRes = { success: boolean; history_removed?: number }

type Props = {
  gw: Gateway
  toast: Toast
  dialog: DialogContext
  /** Pre-loaded list (used when Esc re-opens at list view). */
  initial?: ListRes
  sel?: number
}

const RollbackDialog = (props: Props) => {
  const theme = useTheme().theme
  const [data, setData] = useState<ListRes | null>(props.initial ?? null)
  const [sel, setSel] = useState(props.sel ?? 0)
  const [diff, setDiff] = useState<DiffRes | null>(null)
  const [opened, setOpened] = useState<Checkpoint | null>(null)
  const [confirm, setConfirm] = useState(false)
  const seq = useRef(0)
  const restoring = useRef(false)

  useEffect(() => {
    if (props.initial) return
    props.gw.request<ListRes>("rollback.list")
      .then(setData)
      .catch((e: Error) => setData({ enabled: false, checkpoints: [], err: e.message }))
  }, [props.gw, props.initial])
  useEffect(() => () => { seq.current++ }, [])

  const points = data?.checkpoints ?? []
  const cur = points[sel]
  const target = opened ?? cur

  const open = (cp: Checkpoint) => {
    const id = ++seq.current
    props.gw.request<DiffRes>("rollback.diff", { hash: cp.hash })
      .then(next => {
        if (seq.current !== id) return
        setOpened(cp)
        setDiff(next)
      })
      .catch((e: Error) => { if (seq.current === id) props.toast.error(e) })
  }

  const back = () => {
    seq.current++
    setDiff(null)
    setOpened(null)
    setConfirm(false)
    // Provider already dispatched clear() on this Esc — replace() wins
    // the batch. React reconciles same-type at same slot and keeps our
    // state, so the setDiff(null) above is what actually flips the view.
    props.dialog.replace(
      <RollbackDialog gw={props.gw} toast={props.toast} dialog={props.dialog}
        initial={data ?? undefined} sel={sel} />,
    )
  }

  const restore = (cp: Checkpoint) => {
    if (restoring.current) return
    restoring.current = true
    props.gw.request<RestoreRes>("rollback.restore", { hash: cp.hash })
      .then(r => {
        if (!r.success) throw new Error("restore rejected")
        const n = r.history_removed
        props.toast.show({ variant: "success",
          message: `Restored ${cp.hash.slice(0, 7)}${n ? ` · ${n} turns removed` : ""}` })
        props.dialog.clear()
      })
      .catch((e: Error) => {
        props.toast.show({ variant: "error", message: `Restore failed: ${e.message}` })
        props.dialog.clear()
      })
      .finally(() => { restoring.current = false })
  }

  const keys = useKeys()
  useKeyboard((key) => {
    if (diff) {
      if (confirm) {
        if (target && keys.match("dialog.confirm", key)) return restore(target)
        if (keys.match("dialog.deny", key) || keys.match("dialog.cancel", key)) {
          setConfirm(false); return back()
        }
        return
      }
      if (keys.match("dialog.cancel", key)) return back()
      if (key.name === "r") return setConfirm(true)
      return
    }
    if (!data?.enabled) return
    handleListKey(keys, key, {
      count: points.length, setSel,
      onActivate: () => { if (cur) open(cur) },
    })
  })

  if (!data) return (
    <box width={60} height={3}>
      <text fg={theme.textMuted}>Loading checkpoints…</text>
    </box>
  )

  if (!data.enabled) return (
    <box flexDirection="column" width={60} height={5}>
      <box height={1}><text fg={theme.warning}><strong>{data.err ? "Rollback unavailable" : "Checkpoints disabled"}</strong></text></box>
      <box height={1} />
      <box height={1}><text fg={theme.textMuted}>{data.err ?? "Enable checkpoints in config to use /rollback."}</text></box>
      <box height={1} />
      <box height={1}><text fg={theme.textMuted}>Esc to close</text></box>
    </box>
  )

  if (diff) {
    const body = diff.rendered || diff.diff || diff.stat || "(empty diff)"
    return (
      <box flexDirection="column" width={110} height={30}>
        <box height={1}><text>
          <span fg={theme.primary}><strong>Rollback · </strong></span>
          <span fg={theme.accent}>{target?.hash.slice(0, 7) ?? ""}</span>
          <span fg={theme.textMuted}>{`  ${trunc(target?.message ?? "", 70)}`}</span>
        </text></box>
        <box height={1}><text fg={theme.textMuted}>{diff.stat || " "}</text></box>
        <box height={1} />
        <scrollbox scrollY flexGrow={1}>
          <box flexDirection="column" width="100%">
            <DiffBlock text={body} />
          </box>
        </scrollbox>
        <box height={1} />
        {confirm ? (
          <box height={1}><text>
            <span fg={theme.warning}><strong>Restore this checkpoint?  </strong></span>
            <span fg={theme.textMuted}>[y] restore  [n] cancel</span>
          </text></box>
        ) : (
          <box height={1}><text fg={theme.textMuted}>[r] restore  ·  Esc back</text></box>
        )}
      </box>
    )
  }

  return (
    <box flexDirection="column" width={90} height={Math.min(28, Math.max(8, points.length + 6))}>
      <box height={1}><text fg={theme.primary}><strong>Rollback</strong></text></box>
      <box height={1}><text fg={theme.textMuted}>
        {`${points.length} checkpoints  ·  ↑↓ navigate  Enter diff  Esc close`}
      </text></box>
      <box height={1} />
      {points.length === 0 ? (
        <box height={1}><text fg={theme.textMuted}>No checkpoints yet.</text></box>
      ) : (
        <scrollbox scrollY flexGrow={1}>
          <box flexDirection="column" width="100%">
            {points.map((cp, i) => {
              const on = i === sel
              return (
                <box key={cp.hash} height={1}
                     backgroundColor={on ? theme.backgroundElement : undefined}
                     onMouseDown={() => { setSel(i); open(cp) }}
                     onMouseOver={() => setSel(i)}>
                  <text>
                    <span fg={on ? theme.primary : theme.textMuted}>{on ? "▸ " : "  "}</span>
                    <span fg={theme.accent}>{cp.hash.slice(0, 7).padEnd(9)}</span>
                    <span fg={theme.textMuted}>{ago(cp.timestamp).padEnd(12)}</span>
                    <span fg={on ? theme.text : theme.textMuted}>{trunc(cp.message, 56)}</span>
                  </text>
                </box>
              )
            })}
          </box>
        </scrollbox>
      )}
    </box>
  )
}

export const openRollback = (dialog: DialogContext, gw: Gateway, toast: Toast) =>
  dialog.replace(<RollbackDialog gw={gw} toast={toast} dialog={dialog} />)
