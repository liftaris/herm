export type Lane = "production" | "semantic" | "temporal" | "company" | "context" | "workflow"
export type Status = "active" | "shadow" | "stub" | "blocked"

export type Candidate = {
  name: string
  lane: Lane
  status: Status
  writes: boolean
  authority: boolean
  notes: string
  env?: string[]
}

export const candidates: Candidate[] = [
  { name: "hermes-router", lane: "production", status: "active", writes: false, authority: false, notes: "Production routed read governor." },
  { name: "agentmemory", lane: "semantic", status: "active", writes: true, authority: false, notes: "Current semantic write owner." },
  { name: "mnemosyne", lane: "semantic", status: "shadow", writes: false, authority: false, notes: "Local/profile-scoped candidate." },
  { name: "gbrain", lane: "workflow", status: "shadow", writes: false, authority: false, notes: "Standalone project/workflow graph candidate." },
  { name: "gbrain-gstack", lane: "workflow", status: "stub", writes: false, authority: false, notes: "Combined operating-loop candidate." },
  { name: "hermes-lcm", lane: "context", status: "stub", writes: false, authority: false, notes: "Context compaction/recovery candidate." },
  { name: "hindsight", lane: "semantic", status: "stub", writes: false, authority: false, notes: "Learning memory backend and dashboard candidate.", env: ["HINDSIGHT_URL"] },
  { name: "mem0", lane: "semantic", status: "stub", writes: false, authority: false, notes: "Market benchmark memory layer.", env: ["MEM0_API_KEY"] },
  { name: "graphiti-zep", lane: "temporal", status: "stub", writes: false, authority: false, notes: "Temporal graph/stale-context candidate.", env: ["ZEP_API_KEY"] },
  { name: "cognee", lane: "company", status: "stub", writes: false, authority: false, notes: "Company-brain graph/vector candidate.", env: ["COGNEE_API_KEY"] },
  { name: "supermemory", lane: "semantic", status: "stub", writes: false, authority: false, notes: "Memory/profile/connectors candidate.", env: ["SUPERMEMORY_API_KEY"] },
]

export const writers = candidates.filter(x => x.writes)
export const candidate = (name: string): Candidate | undefined => candidates.find(x => x.name === name)

export * as registry from "./memory-candidates"
