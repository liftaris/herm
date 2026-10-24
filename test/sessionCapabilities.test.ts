import { describe, expect, test } from "bun:test"
import { sessionCapabilities } from "../src/app/sessionCapabilities"

describe("session capabilities", () => {
  test("a connected session can submit before metadata arrives", () => {
    expect(sessionCapabilities({ sid: "live", ready: false, streaming: false })).toEqual({
      sessionConnected: true, metadataHydrated: false,
      canSubmitPrompt: true, canDispatchGatewayCommand: true, canDrainQueue: true,
    })
  })

  test("a running turn keeps queued prompts waiting", () => {
    expect(sessionCapabilities({ sid: "live", ready: true, streaming: true })).toMatchObject({
      canSubmitPrompt: true, canDispatchGatewayCommand: true, canDrainQueue: false,
    })
  })

  test("metadata alone cannot create a connected session", () => {
    expect(sessionCapabilities({ sid: "", ready: true, streaming: false })).toMatchObject({
      canSubmitPrompt: false, canDispatchGatewayCommand: false, canDrainQueue: false,
    })
  })
})
