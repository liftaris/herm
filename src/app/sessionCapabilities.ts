export type SessionCapabilityInput = {
  sid?: string | null
  ready: boolean
  streaming: boolean
}

export type SessionCapabilities = {
  sessionConnected: boolean
  metadataHydrated: boolean
  canSubmitPrompt: boolean
  canDispatchGatewayCommand: boolean
  canDrainQueue: boolean
}

export function sessionCapabilities(input: SessionCapabilityInput): SessionCapabilities {
  const sessionConnected = Boolean(input.sid)
  const metadataHydrated = input.ready

  return {
    sessionConnected,
    metadataHydrated,
    canSubmitPrompt: sessionConnected,
    canDispatchGatewayCommand: sessionConnected,
    canDrainQueue: sessionConnected && !input.streaming,
  }
}
