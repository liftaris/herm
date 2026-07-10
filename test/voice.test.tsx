import { expect, test } from "bun:test"
import { act } from "react"
import { mount, mountNode, until } from "./harness"
import { useVoice, type VoiceApi } from "../src/voice/useVoice"

test("failed voice stop restores recording state", async () => {
  let api: VoiceApi | undefined
  const messages: string[] = []
  const rpc = async <T,>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "voice.toggle") return { enabled: true, tts: false, record_key: "ctrl+b" } as T
    if (method === "voice.record" && params.action === "start") return { status: "recording" } as T
    if (method === "voice.record" && params.action === "stop") throw new Error("stop exploded")
    throw new Error(`unexpected ${method}`)
  }
  const Probe = () => {
    api = useVoice(rpc, text => messages.push(text))
    return <text>{`recording:${api.state.recording}`}</text>
  }
  await using t = await mountNode(<Probe />)

  await act(async () => { await api!.toggle("on", "sid") })
  await t.settle()
  await act(async () => { await api!.record("sid") })
  await t.settle()
  expect(t.frame()).toContain("recording:true")
  await act(async () => { await api!.record("sid") })
  await t.settle()

  expect(t.frame()).toContain("recording:true")
  expect(messages.at(-1)).toBe("voice error: stop exploded")
})

test("turning voice off clears the active recording state", async () => {
  let api: VoiceApi | undefined
  const rpc = async <T,>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "voice.toggle")
      return { enabled: params.action !== "off", tts: false, record_key: "ctrl+b" } as T
    if (method === "voice.record") return { status: "recording" } as T
    throw new Error(`unexpected ${method}`)
  }
  const Probe = () => {
    api = useVoice(rpc, () => {})
    return <text>{`enabled:${api.state.enabled} recording:${api.state.recording}`}</text>
  }
  await using t = await mountNode(<Probe />)

  await act(async () => { await api!.toggle("on", "sid") })
  await t.settle()
  await act(async () => { await api!.record("sid") })
  await t.settle()
  expect(t.frame()).toContain("enabled:true recording:true")

  await act(async () => { await api!.toggle("off", "sid") })
  await t.settle()
  expect(t.frame()).toContain("enabled:false recording:false")
})

test("record presses serialize while the gateway request is pending", async () => {
  let api: VoiceApi | undefined
  let release!: () => void
  let records = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const rpc = async <T,>(method: string): Promise<T> => {
    if (method === "voice.toggle") return { enabled: true, record_key: "ctrl+b" } as T
    if (method === "voice.record") {
      records++
      await gate
      return { status: "recording" } as T
    }
    throw new Error(`unexpected ${method}`)
  }
  const Probe = () => {
    api = useVoice(rpc, () => {})
    return <text>{`recording:${api.state.recording}`}</text>
  }
  await using t = await mountNode(<Probe />)
  await act(async () => { await api!.toggle("on", "sid") })
  await t.settle()

  act(() => {
    void api!.record("sid")
    void api!.record("sid")
  })
  expect(records).toBe(1)
  release()
  await t.settle()
})

test("out-of-order voice toggles keep the latest action", async () => {
  let api: VoiceApi | undefined
  let on!: (value: unknown) => void
  let off!: (value: unknown) => void
  const enabled = new Promise(resolve => { on = resolve })
  const disabled = new Promise(resolve => { off = resolve })
  const rpc = async <T,>(_method: string, params: Record<string, unknown>): Promise<T> =>
    (params.action === "on" ? enabled : disabled) as Promise<T>
  const Probe = () => {
    api = useVoice(rpc, () => {})
    return <text>{`enabled:${api.state.enabled}`}</text>
  }
  await using t = await mountNode(<Probe />)

  act(() => {
    void api!.toggle("on", "sid")
    void api!.toggle("off", "sid")
  })
  off({ enabled: false, record_key: "ctrl+b" })
  await act(async () => { await disabled })
  on({ enabled: true, record_key: "ctrl+b" })
  await act(async () => { await enabled })
  await t.settle()

  expect(t.frame()).toContain("enabled:false")
})

test("late record failure cannot revive voice after toggle off", async () => {
  let api: VoiceApi | undefined
  let fail!: (error: Error) => void
  let stops = 0
  const pending = new Promise<never>((_resolve, reject) => { fail = reject })
  const rpc = async <T,>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "voice.toggle")
      return { enabled: params.action !== "off", record_key: "ctrl+b" } as T
    if (method === "voice.record" && params.action === "start") return { status: "recording" } as T
    if (method === "voice.record") { stops++; return pending }
    throw new Error(`unexpected ${method}`)
  }
  const Probe = () => {
    api = useVoice(rpc, () => {})
    return <text>{`enabled:${api.state.enabled} recording:${api.state.recording}`}</text>
  }
  await using t = await mountNode(<Probe />)
  await act(async () => { await api!.toggle("on", "sid") })
  await t.settle()
  await act(async () => { await api!.record("sid") })
  await t.settle()

  act(() => { void api!.record("sid") })
  expect(stops).toBe(1)
  await act(async () => { await api!.toggle("off", "sid") })
  fail(new Error("late stop failure"))
  await act(async () => { await Bun.sleep(20) })
  await t.settle()
  expect(t.frame()).toContain("enabled:false recording:false")
})

test("gateway voice events drive the indicator and submit transcripts", async () => {
  await using t = await mount()
  await until(t, () => t.frame().includes("Ready"))

  act(() => t.gw.push({ type: "voice.status", payload: { state: "listening" } }))
  await until(t, () => t.frame().includes("recording"))
  act(() => t.gw.push({ type: "voice.status", payload: { state: "transcribing" } }))
  await until(t, () => t.frame().includes("transcribing"))
  act(() => t.gw.push({ type: "voice.transcript", payload: { text: "spoken prompt" } }))
  await until(t, () => t.gw.last("prompt.submit")?.params.text === "spoken prompt")
})

test("no-speech limit disables voice without submitting", async () => {
  await using t = await mount()
  await until(t, () => t.frame().includes("Ready"))
  act(() => t.gw.push({ type: "voice.status", payload: { state: "listening" } }))
  await until(t, () => t.frame().includes("recording"))
  act(() => t.gw.push({ type: "voice.transcript", payload: { no_speech_limit: true } }))
  await until(t, () => t.frame().includes("voice: disabled after repeated silence"))
  expect(t.frame()).not.toContain("recording")
  expect(t.gw.last("prompt.submit")).toBeUndefined()
})

test("old record completion cannot unlock a newer pending request", async () => {
  let api: VoiceApi | undefined
  let failOld!: (error: Error) => void
  let finishNew!: (value: unknown) => void
  let records = 0
  const old = new Promise<never>((_resolve, reject) => { failOld = reject })
  const fresh = new Promise(resolve => { finishNew = resolve })
  const rpc = async <T,>(method: string): Promise<T> => {
    if (method === "voice.toggle") return { enabled: true, record_key: "ctrl+b" } as T
    if (method === "voice.record") return (++records === 1 ? old : fresh) as Promise<T>
    throw new Error(`unexpected ${method}`)
  }
  const Probe = () => {
    api = useVoice(rpc, () => {})
    return <text>{`recording:${api.state.recording}`}</text>
  }
  await using t = await mountNode(<Probe />)
  await act(async () => { await api!.toggle("on", "sid") })
  await t.settle()
  act(() => { void api!.record("sid") })

  act(() => api!.reset())
  await act(async () => { await api!.toggle("on", "sid") })
  await t.settle()
  act(() => { void api!.record("sid") })
  expect(records).toBe(2)

  failOld(new Error("old request ended"))
  await act(async () => { await Bun.sleep(20) })
  act(() => { void api!.record("sid") })
  expect(records).toBe(2)
  finishNew({ status: "recording" })
  await t.settle()
})

test("voice status reports missing provider details", async () => {
  let api: VoiceApi | undefined
  const messages: string[] = []
  const rpc = async <T,>(): Promise<T> => ({
    enabled: false,
    available: false,
    record_key: "ctrl+b",
    details: "STT provider missing",
  }) as T
  const Probe = () => {
    api = useVoice(rpc, text => messages.push(text))
    return <text>voice</text>
  }
  await using _t = await mountNode(<Probe />)

  await act(async () => { await api!.toggle("status", "sid") })
  expect(messages.at(-1)).toContain("STT provider missing")
})
