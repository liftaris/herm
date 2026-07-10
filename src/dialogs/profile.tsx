// Per-profile action menu. All mutations route through the hermes CLI
// via `shell.exec` so herm doesn't duplicate validation/cleanup logic.
// "Open …" actions use the OS handler (openFile) rather than an
// in-TUI editor — SOUL.md and config.yaml are multi-hundred-line
// files, not composer-sized inputs.

import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { useKeys } from "../keys"
import { useTheme } from "../theme"
import { DialogSelect, type SelectOption } from "../ui/dialog-select"
import type { DialogContext } from "../ui/dialog"
import type { ProfileInfo } from "../service/hermes-profiles"
import { openFile } from "../utils/open-file"
import { openDistributionInfo } from "./distribution-info"

export type ProfileOps = {
  switch?: () => void
  sticky: (p: ProfileInfo) => void
  unsticky: () => void
  export: (p: ProfileInfo) => void
  remove: (p: ProfileInfo) => void
  update: (p: ProfileInfo, force: boolean) => void
}

export function openProfileMenu(dialog: DialogContext, p: ProfileInfo, ops: ProfileOps) {
  const opts: SelectOption[] = [
    ...(ops.switch && !p.is_active
      ? [{ category: "Switch", value: "switch", title: `Switch to '${p.name}'`,
           description: "restart gateway under this HERMES_HOME — ends current session" }]
      : []),
    { category: "Open", value: "soul", title: "SOUL.md", description: "edit persona/system prompt" },
    { category: "Open", value: "config", title: "config.yaml", description: "model, provider, toolsets" },
    ...(p.has_env
      ? [{ category: "Open", value: "env", title: ".env", description: "API keys + secrets" }] : []),
    { category: "Open", value: "dir", title: "Directory", description: p.path },
    ...(p.distribution
      ? [
          { category: "Distribution", value: "dist-info", title: "Info",
            description: `v${p.distribution.version}${p.distribution.source ? `  ·  ${p.distribution.source}` : ""}` },
          { category: "Distribution", value: "dist-update", title: "Update",
            description: `hermes profile update ${p.name}${p.is_active ? "  ·  ends current session" : ""}` },
        ]
      : []),
    ...(p.is_sticky
      ? [{ category: "Default", value: "unsticky", title: "Clear sticky default",
           description: "hermes profile use --clear" }]
      : [{ category: "Default", value: "sticky", title: "Set as sticky default",
           description: `hermes profile use ${p.name}` }]),
    { category: "Manage", value: "export", title: "Export",
      description: `hermes profile export ${p.name}` },
    ...(p.is_default || p.is_active ? []
      : [{ category: "Manage", value: "delete", title: "Delete",
           description: "irreversible — removes config, env, memory, sessions" }]),
  ]

  dialog.replace(
    <DialogSelect
      title={`Profile · ${p.name}${p.is_active ? " (active)" : ""}`}
      options={opts}
      onSelect={(o) => {
        if (o.value === "dist-info") {
          if (!p.distribution) return dialog.clear()
          return openDistributionInfo(dialog, {
            profile: p.name, d: p.distribution, yaml: p.sources.distribution,
          })
        }
        if (o.value === "dist-update") {
          if (!p.distribution) return dialog.clear()
          return openUpdateDistribution(dialog, p, force => ops.update(p, force))
        }
        dialog.clear()
        if (o.value === "switch") return ops.switch?.()
        if (o.value === "soul") return openFile(p.sources.soul.file)
        if (o.value === "config") return openFile(p.sources.config.file)
        if (o.value === "env") return openFile(p.sources.env.file)
        if (o.value === "dir") return openFile(p.path)
        if (o.value === "sticky") return ops.sticky(p)
        if (o.value === "unsticky") return ops.unsticky()
        if (o.value === "export") return ops.export(p)
        if (o.value === "delete") return ops.remove(p)
      }}
    />,
  )
}

// Update confirm. Quotes source + version, offers a Space-toggled
// `--force-config` checkbox, and warns when updating the active
// profile (gateway will re-spawn; current session is lost).
const UpdateForm = (props: { p: ProfileInfo; done: (force: boolean | null) => void }) => {
  const theme = useTheme().theme
  const keys = useKeys()
  const [force, setForce] = useState(false)
  useKeyboard((key) => {
    if (keys.match("dialog.cancel", key) || keys.match("dialog.deny", key)) return props.done(null)
    if (keys.match("dialog.confirm", key) || keys.match("dialog.accept", key)) return props.done(force)
    if (key.name === "space" || key.name === " ") return setForce(f => !f)
  })
  const d = props.p.distribution!
  return (
    <box flexDirection="column" width={62} gap={1}>
      <box height={1}>
        <text fg={theme.warning}><strong>Update distribution?</strong></text>
      </box>
      <box flexDirection="column">
        <box minHeight={1}>
          <text wrapMode="word">
            {`'${props.p.name}' · v${d.version}${d.source ? ` · ${d.source}` : ""}`}
          </text>
        </box>
        <box minHeight={1}>
          <text wrapMode="word" fg={theme.textMuted}>
            {"Re-pulls from source; distribution-owned files are overwritten."}
          </text>
        </box>
        {props.p.is_active ? (
          <box minHeight={1}>
            <text wrapMode="word" fg={theme.warning}>
              {"⚠ This is the active profile. The gateway will re-spawn "
                + "and the current session will end."}
            </text>
          </box>
        ) : null}
      </box>
      <box height={1}>
        <text fg={force ? theme.warning : theme.textMuted}>
          {`${force ? "[x]" : "[ ]"} --force-config  ·  also overwrite config.yaml`}
        </text>
      </box>
      <box height={1}>
        <text fg={theme.textMuted}>
          {`[${keys.print("dialog.confirm")}] update   [Space] toggle force   [${keys.print("dialog.cancel")}] cancel`}
        </text>
      </box>
    </box>
  )
}

function openUpdateDistribution(
  dialog: DialogContext,
  p: ProfileInfo,
  onConfirm: (force: boolean) => void,
) {
  dialog.replace(
    <UpdateForm p={p} done={(force) => {
      dialog.clear()
      if (force !== null) onConfirm(force)
    }} />,
  )
}
