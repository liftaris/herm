import { backend, type BackendContract } from "../context/backend-contract"

export type SessionCapabilityInput = {
  sid?: string | null
  ready: boolean
  streaming: boolean
  contract?: BackendContract | null
}

export type SessionCapabilities = {
  sessionConnected: boolean
  metadataHydrated: boolean
  minContract: number
  maxContract: number
  observedContract?: number
  contractSupported: boolean
  contractReason: BackendContract["reason"]
  contractMessage?: string
  canSubmitPrompt: boolean
  canDispatchGatewayCommand: boolean
  canDrainQueue: boolean
}

export function sessionCapabilities(input: SessionCapabilityInput): SessionCapabilities {
  const sessionConnected = Boolean(input.sid)
  const metadataHydrated = input.ready
  const contract = input.contract ?? backend.backendContract(null)
  const ok = contract.supported

  return {
    sessionConnected,
    metadataHydrated,
    minContract: contract.minContract,
    maxContract: contract.maxContract,
    observedContract: contract.observedContract,
    contractSupported: ok,
    contractReason: contract.reason,
    contractMessage: ok ? undefined : backend.contractMessage(contract),
    canSubmitPrompt: sessionConnected && ok,
    canDispatchGatewayCommand: sessionConnected && ok,
    canDrainQueue: sessionConnected && ok && !input.streaming,
  }
}
