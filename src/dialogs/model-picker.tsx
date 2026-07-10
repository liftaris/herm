// Pick provider → model. Default scope is the *current session* (the
// gateway applies the switch to the live agent when `session_id` is
// passed); Tab toggles to global persist. The gateway's `config.set`
// accepts a single space-separated arg string with `--provider` /
// `--global` flags (same grammar as the `/model` slash command) and
// routes through `_apply_model_switch`, so we send one request rather
// than a provider/model pair.

import { useEffect, useState, useCallback, useRef } from "react"
import type { ParsedKey } from "@opentui/core"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type SelectOption } from "../ui/dialog-select"
import { SecretPrompt } from "./secret-prompt"
import { useTheme } from "../theme"
import { useToast } from "../ui/toast"
import { useKeys } from "../keys/context"
import type { Gateway } from "../context/gateway"
import type { ConfigSetResponse, ModelOptionProvider, ModelOptionsResponse } from "../context/wire"

type Step = "provider" | "model" | "setup"

type Props = {
  gw: Gateway
  /** Override the default "switch this session / global" apply. When
   *  set, the scope toggle is hidden and the caller owns the write. */
  onApply?: (provider: string, model: string) => Promise<void>
  title?: string
  refresh?: boolean
}

type SaveKeyResponse = {
  provider?: ModelOptionProvider
  warning?: string
}

const REFRESH = "__refresh__"

const configured = (p: ModelOptionProvider) => (p.models?.length ?? 0) > 0

const setupDescription = (p: ModelOptionProvider): string | undefined => {
  if (p.warning) return p.warning
  if (p.auth_type === "api_key" && p.key_env) return `paste ${p.key_env} to activate`
  if (p.auth_type === "vertex") return p.key_env
    ? `set ${p.key_env} to your service-account JSON path`
    : "configure Vertex credentials with hermes model"
  if (p.key_env) return `set ${p.key_env} before using this provider`
  if (p.auth_type) return `run hermes model to configure (${p.auth_type})`
  return undefined
}

const providerDescription = (p: ModelOptionProvider): string | undefined => {
  if (p.authenticated === false) return setupDescription(p)
  return p.total_models ? `${p.total_models} models` : undefined
}

const replaceProvider = (
  data: ModelOptionsResponse, slug: string, next: ModelOptionProvider,
): ModelOptionsResponse => ({
  ...data,
  providers: (data.providers ?? []).map(p => p.slug === slug ? next : p),
})

const ModelPickerDialog = (props: Props) => {
  const dialog = useDialog()
  const toast = useToast()
  const keys = useKeys()
  const theme = useTheme().theme
  const [data, setData] = useState<ModelOptionsResponse | null>(null)
  const [step, setStep] = useState<Step>("provider")
  const [provider, setProvider] = useState<string | null>(null)
  const [setupProvider, setSetupProvider] = useState<ModelOptionProvider | null>(null)
  const [global, setGlobal] = useState(false)
  const seq = useRef(0)

  const load = useCallback(async (force = false, quiet = false) => {
    const id = ++seq.current
    try {
      const next = await props.gw.request<ModelOptionsResponse>("model.options", force
        ? { refresh: true, include_unconfigured: true }
        : { include_unconfigured: true })
      if (seq.current !== id) return null
      setData(d => force || !d ? next : d)
      return next
    } catch (e) {
      if (seq.current !== id) return null
      if (!quiet) toast.show({ variant: "error", message: e instanceof Error ? e.message : String(e) })
      const empty = { providers: [] }
      setData(d => d ?? empty)
      return null
    }
  }, [props.gw, toast])

  const refresh = useCallback(() => {
    toast.show({ variant: "info", message: "Refreshing model catalog; custom-provider probes may be slower…" })
    void load(true)
  }, [load, toast])

  useEffect(() => {
    void load(Boolean(props.refresh))
    return () => { seq.current++ }
  }, [load, props.refresh])

  const apply = useCallback((model: string, prov: string) => {
    if (props.onApply) return void props.onApply(prov, model)
      .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
    const value = `${model} --provider ${prov}${global ? " --global" : ""}`
    props.gw.request<ConfigSetResponse>("config.set", global
      ? { key: "model", value, session_id: undefined }
      : { key: "model", value })
      .then(r => {
        toast.show({ variant: "success", message: `model → ${r.value ?? model}${global ? " (global)" : ""}` })
        if (r.warning) toast.show({ variant: "warning", message: r.warning })
      })
      .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
  }, [props.gw, props.onApply, global, toast])

  const submitKey = useCallback(async (p: ModelOptionProvider, key: string) => {
    try {
      const r = await props.gw.request<SaveKeyResponse>("model.save_key", { slug: p.slug, api_key: key })
      if (r.warning) toast.show({ variant: "warning", message: r.warning })
      const direct = r.provider && configured(r.provider) ? r.provider : null
      const opts = direct ? null : await load(true, true)
      const hit = opts?.providers?.find(pp => pp.slug === p.slug)
      const next = direct ?? (hit && configured(hit) ? hit : r.provider ?? hit)
      if (!next) {
        toast.show({ variant: "warning", message: "Provider saved; refresh model options to continue" })
        return
      }
      setData(d => d ? replaceProvider(d, p.slug, next) : d)
      if (configured(next)) {
        setSetupProvider(null)
        setProvider(next.slug)
        setStep("model")
        toast.show({ variant: "success", message: `${next.name} activated` })
        return
      }
      toast.show({ variant: "warning", message: next.warning ?? "Provider saved but no models were returned" })
    } catch (e) {
      toast.show({ variant: "error", message: e instanceof Error ? e.message : String(e) })
    }
  }, [props.gw, load, toast])

  const setup = useCallback((p: ModelOptionProvider) => {
    const msg = setupDescription(p)
    if (p.auth_type !== "api_key" || !p.key_env) {
      toast.show({ variant: "warning", message: msg ?? "Run hermes model to configure this provider" })
      return
    }
    setSetupProvider(p)
    setStep("setup")
  }, [toast])

  const onKey = useCallback((k: ParsedKey) => {
    if (k.name === "f5" || keys.match("list.refresh", k)) { refresh(); return true }
    if (k.name === "tab" && !props.onApply) { setGlobal(g => !g); return true }
    if (k.name === "left" && step !== "provider") { setStep("provider"); return true }
    return false
  }, [keys, props.onApply, refresh, step])

  const hint = `${keys.print("list.refresh")} refresh`
  const footer = props.onApply
    ? <text fg={theme.textMuted}>{step === "model" ? `${hint} · ← providers` : hint}</text>
    : (
      <text fg={theme.textMuted}>
        <span>Scope: </span>
        <span fg={global ? theme.warning : theme.accent}>
          {global ? "global (persists to config)" : "this session"}
        </span>
        <span>{` · Tab toggle · ${hint}${step === "model" ? " · ← providers" : ""}`}</span>
      </text>
    )

  if (!data) return <box width={50} padding={1}><text>Loading models…</text></box>

  if (step === "setup" && setupProvider?.key_env) return <SecretPrompt
    title={`Paste ${setupProvider.key_env}`}
    label={setupDescription(setupProvider) ?? `API key for ${setupProvider.name}`}
    onSubmit={(key) => { void submitKey(setupProvider, key) }}
  />

  if (step === "provider") {
    const options: SelectOption[] = [
      ...(data.providers ?? [])
        .toSorted((a, b) => Number(Boolean(b.is_current)) - Number(Boolean(a.is_current)))
        .map(p => ({
          title: p.name,
          value: p.slug,
          description: providerDescription(p),
          category: p.is_current ? "Current" : p.authenticated === false ? "Setup required" : "Available",
        })),
      { title: "Refresh model options", value: REFRESH, description: "force reload from gateway", hint: undefined, category: "Actions" },
    ]
    return (
      <DialogSelect
        title={props.title ?? "Switch Provider"}
        options={options}
        current={data.provider}
        onSelect={(o) => {
          if (o.value === REFRESH) return refresh()
          const p = data.providers?.find(pp => pp.slug === o.value)
          if (p?.authenticated === false || (p && !configured(p))) return void setup(p)
          setProvider(o.value)
          setStep("model")
        }}
        onKey={onKey}
        placeholder="Search providers..."
        footer={footer}
      />
    )
  }

  const p = data.providers?.find(pp => pp.slug === provider)
  const options: SelectOption[] = [
    ...(p?.models ?? []).map(m => {
      const caps = p?.capabilities?.[m]
      const badges = [
        caps?.fast ? "fast" : "",
        caps?.reasoning ? "reasoning" : "",
      ].filter(Boolean)
      return {
        title: m,
        value: m,
        hint: badges.length > 0 ? badges.join(" · ") : undefined,
      }
    }),
    { title: "Refresh model options", value: REFRESH, description: "force reload from gateway", hint: undefined, category: "Actions" },
  ]

  return (
    <DialogSelect
      title={props.title ? `${props.title} · ${p?.name ?? provider}` : `Switch Model (${p?.name ?? provider})`}
      options={options}
      current={provider === data.provider ? data.model : undefined}
      onSelect={(o) => {
        if (o.value === REFRESH) return refresh()
        dialog.clear()
        if (provider) apply(o.value, provider)
      }}
      onKey={onKey}
      placeholder="Search models..."
      footer={footer}
    />
  )
}

export const openModelPicker = (
  dialog: ReturnType<typeof useDialog>, gw: Gateway,
  opts?: { title?: string; onApply?: (provider: string, model: string) => Promise<void>; refresh?: boolean },
) => {
  dialog.replace(<ModelPickerDialog gw={gw} title={opts?.title} onApply={opts?.onApply} refresh={opts?.refresh} />)
}
