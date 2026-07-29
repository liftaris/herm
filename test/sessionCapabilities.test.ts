import { describe, expect, test } from "bun:test"
import { backend } from "../src/context/backend-contract"
import { sessionCapabilities } from "../src/app/sessionCapabilities"

const info = (desktop_contract: unknown, extra: Record<string, unknown> = {}) =>
  backend.backendContract({ desktop_contract, ...extra })

describe("backend contract", () => {
  test("missing session.info contract fails closed before mutating RPCs", () => {
    const state = backend.backendContract({ version: "0.19.0", update_command: "hermes update" })

    expect(state).toMatchObject({
      minContract: 4,
      maxContract: 5,
      supported: false,
      reason: "missing",
      version: "0.19.0",
      updateCommand: "hermes update",
    })
    expect(backend.contractError("prompt.submit", state)?.message).toContain("Blocked prompt.submit")
    expect(backend.contractError("config.get", state)).toBeNull()
  })

  test("malformed contract fails closed with an explainable reason", () => {
    const state = info("4")

    expect(state).toMatchObject({ supported: false, reason: "malformed" })
    expect(state.observedContract).toBeUndefined()
    expect(backend.contractError("session.steer", state)?.message).toContain("malformed")
  })

  test("older producer contract blocks mutating RPCs", () => {
    const state = info(3, { source_revision: "abc123" })

    expect(state).toMatchObject({
      observedContract: 3,
      sourceRevision: "abc123",
      supported: false,
      reason: "older",
    })
    expect(backend.contractError("approval.respond", state)?.message).toContain("older")
  })

  test("current supported producer contract enables session capabilities", () => {
    const cap = sessionCapabilities({
      sid: "lazy-sid",
      ready: true,
      streaming: false,
      contract: info(4),
    })

    expect(cap).toMatchObject({
      sessionConnected: true,
      metadataHydrated: true,
      minContract: 4,
      maxContract: 5,
      observedContract: 4,
      contractSupported: true,
      contractReason: "supported",
      canSubmitPrompt: true,
      canDispatchGatewayCommand: true,
      canDrainQueue: true,
    })
  })

  test("newer producer contract is surfaced as unsupported", () => {
    const state = info(6)

    expect(state).toMatchObject({
      observedContract: 6,
      supported: false,
      reason: "newer",
    })
    expect(backend.contractError("prompt.submit", state)?.message).toContain("newer than Herm supports")
  })
})

describe("sessionCapabilities", () => {
  test("session id alone does not enable mutations before contract hydration", () => {
    expect(sessionCapabilities({ sid: "lazy-sid", ready: false, streaming: false })).toMatchObject({
      sessionConnected: true,
      metadataHydrated: false,
      contractSupported: false,
      contractReason: "missing",
      canSubmitPrompt: false,
      canDispatchGatewayCommand: false,
      canDrainQueue: false,
    })
  })

  test("queue drain waits for idle and supported contract", () => {
    expect(sessionCapabilities({ sid: "lazy-sid", ready: true, streaming: true, contract: info(5) })).toMatchObject({
      canSubmitPrompt: true,
      canDispatchGatewayCommand: true,
      canDrainQueue: false,
    })
  })

  test("missing session id disables session actions even if metadata is marked ready", () => {
    expect(sessionCapabilities({ sid: "", ready: true, streaming: false, contract: info(4) })).toMatchObject({
      sessionConnected: false,
      metadataHydrated: true,
      contractSupported: true,
      canSubmitPrompt: false,
      canDispatchGatewayCommand: false,
      canDrainQueue: false,
    })
  })
})
