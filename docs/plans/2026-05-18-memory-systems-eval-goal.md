# Memory Systems Eval Goal Plan

> **For Hermes:** Use this as the `/goal` mission prompt to build the eval scaffold in small verified slices. Keep production memory writes unchanged until a candidate passes promotion gates.

**Goal:** Build a traceable memory-system eval harness that compares the current Hermes router against candidate memory/context systems without allowing multiple live automatic writers.

**Architecture:** Hermes remains the governor and production router. Obsidian/files remain authority. Candidate systems run in shadow lanes that receive the same trace queries and return scored recall/context packets; only baseline context can affect production turns.

**Tech Stack:** Bun, TypeScript, OpenTUI React tests, Hermes service modules under `src/service/`, JSONL traces under Hermes logs, optional external candidate adapters behind explicit env/config gates.

---

## Candidate Matrix

### Production baseline
- Hardened Hermes router
- agentmemory as current semantic write owner
- Obsidian/repo/config/skills as authority

### Existing candidates
- agentmemory current + later consolidation mode
- Mnemosyne
- GBrain standalone
- GBrain + GStack
- Hermes-LCM as context-engine candidate, not semantic memory backend

### Additional candidates
- Hindsight
- Mem0
- Graphiti/Zep
- Cognee
- Supermemory

## Non-Negotiables

- Do not enable multiple automatic semantic writers.
- Do not let candidate context affect production turns.
- Do not let `<memory-context>` reference blocks trigger tools, APIs, TTS, voice, background work, or implementation by themselves.
- Preserve source provenance in every result.
- Score stale and truncated recall as degraded, not as authority.
- Keep Obsidian/files higher authority than semantic stores.

---

## `/goal` Prompt

Use this inside the TUI:

```text
/goal Build the Hermes memory-systems eval scaffold from docs/plans/2026-05-18-memory-systems-eval-goal.md. Work in small verified slices. Keep production behavior unchanged except for safe trace/eval surfaces. Start by adding a candidate registry and richer shadow trace schema for: agentmemory, Mnemosyne, GBrain, GBrain+GStack, LCM, Hindsight, Mem0, Graphiti/Zep, Cognee, and Supermemory. Candidate adapters may be stubbed behind unavailable/config-missing statuses; do not install or enable external services unless the plan explicitly asks for a safe smoke check. Add tests first for candidate registry, trace shape, reference-only memory-context handling, stale/truncated scoring, and summary output. Run targeted bun tests, then bunx tsc --noEmit, then bun run build. Stop only for missing credentials, irreversible changes, or external installs that require approval. Report touched files and passing checks.
```

---

## Slice 1: Candidate Registry

**Objective:** Add a typed registry that lists every candidate, its lane, status, and required setup without touching production routing.

**Files:**
- Create: `src/service/memory-candidates.ts`
- Test: `test/memory-candidates.test.ts`

**Implementation shape:**

```ts
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
  { name: "hindsight", lane: "semantic", status: "stub", writes: false, authority: false, notes: "Learning memory backend and dashboard candidate." },
  { name: "mem0", lane: "semantic", status: "stub", writes: false, authority: false, notes: "Market benchmark memory layer." },
  { name: "graphiti-zep", lane: "temporal", status: "stub", writes: false, authority: false, notes: "Temporal graph/stale-context candidate." },
  { name: "cognee", lane: "company", status: "stub", writes: false, authority: false, notes: "Company-brain graph/vector candidate." },
  { name: "supermemory", lane: "semantic", status: "stub", writes: false, authority: false, notes: "Memory/profile/connectors candidate." },
]

export const writer = candidates.filter(x => x.writes)
```

**Verification:**
- Test that only `agentmemory` has `writes: true`.
- Test that no candidate has `authority: true`.
- Test that required candidate names are present.

---

## Slice 2: Richer Shadow Trace Schema

**Objective:** Expand shadow trace rows so candidate status and degraded recall are visible.

**Files:**
- Modify: `src/service/memory-context.ts`
- Modify: `src/service/memory-shadow.ts`
- Test: `test/memory-shadow.test.ts`

**Trace fields to add:**
- `candidate.name`
- `candidate.status`
- `candidate.lane`
- `candidate.available`
- `candidate.error?`
- `candidate.injects`
- `candidate.results`
- `candidate.avgMs/sourceMs`
- `candidate.degraded` count

**Verification:**
- Existing shadow tests still pass.
- New tests prove unavailable candidates are logged as unavailable instead of throwing.

---

## Slice 3: Reference Block / Truncation Scoring

**Objective:** Explicitly score recalled `<memory-context>` blocks and truncated snippets as degraded reference context.

**Files:**
- Modify: `src/service/memory-context.ts`
- Modify: `src/service/memory-router.ts`
- Test: `test/memory-context.test.ts`

**Rules:**
- Active query strips `<memory-context>` blocks before retrieval.
- Reference block content may inform only as background after routing.
- Truncated lines ending with `:` or visibly incomplete terms count as degraded.
- Degraded context is traceable and lower-confidence unless recovered from a full source.

**Verification:**
- A prompt containing `<memory-context>` plus a live request queries only the live request.
- Background-only words inside the block cannot trigger recall/action by themselves.
- Truncated memory examples produce degraded trace markers.

---

## Slice 4: Candidate Adapter Stubs

**Objective:** Add adapter factories that fail closed when external systems are not configured.

**Files:**
- Create: `src/service/memory-candidate-adapters.ts`
- Test: `test/memory-candidate-adapters.test.ts`

**Candidates:**
- Hindsight: local API URL env/config optional
- Mem0: API/local mode optional
- Graphiti/Zep: API/local mode optional
- Cognee: local/API optional
- Supermemory: API optional
- Mnemosyne/GBrain/LCM use existing or stub adapters

**Verification:**
- Missing config returns unavailable status, not thrown errors.
- Configured fake endpoint adapter can be tested with a local stub function, not a real service.

---

## Slice 5: Eval Summary Surface

**Objective:** Make it easy to summarize the shadow JSONL into a readable candidate table.

**Files:**
- Modify: `src/service/memory-shadow.ts`
- Optional TUI later: Sessions/Memory tab, not required in this first goal.
- Test: `test/memory-shadow.test.ts`

**Metrics:**
- runs
- wins
- misses
- noise
- degraded
- unavailable
- avgMs
- injects/results

**Verification:**
- Summary handles old JSONL rows and new rows.
- Summary sorts candidates consistently.

---

## Slice 6: Smoke Eval Fixtures

**Objective:** Add deterministic eval prompts and expected behaviors before collecting several days of real traces.

**Files:**
- Create: `test/fixtures/memory-eval-prompts.json`
- Test: `test/memory-eval.test.ts`

**Fixture categories:**
- memory architecture decisions
- Obsidian authority vs semantic hints
- closeout behavior
- Riley/Paperclip/Hermes routing
- stale/truncated memory traps
- iMessage/simple lookup speed preference
- lifestyle tooling inclusion

**Verification:**
- Fixtures validate the baseline router’s authority/routing behavior.
- Candidate comparison can run without external services.

---

## Eval Fixture Runner

Deterministic fixtures live in `test/fixtures/memory-eval-prompts.json`. The service helper `src/service/memory-eval.ts` runs them against local adapters and returns pass/fail rows plus the same shadow summary shape used by JSONL traces.

Run the deterministic local eval:

```bash
bun run memory:eval
# or with a custom fixture file
bun scripts/memory-eval.ts fixtures test/fixtures/memory-eval-prompts.json
```

Summarize shadow JSONL evidence:

```bash
bun run memory:shadow
# or with a specific trace file
bun scripts/memory-eval.ts shadow ~/.hermes/logs/memory-shadow.jsonl
```

The fixture suite covers memory architecture, Obsidian/repo authority, closeouts, Riley/Paperclip routing, stale/truncated traps, iMessage speed, lifestyle tooling, and reference-only `<memory-context>` safety. It requires no external services.

## Promotion Gates

A candidate can move beyond stub/shadow only after it:

- stays read-only in Hermes during evaluation,
- preserves source provenance,
- beats baseline on useful wins without excess noise,
- handles stale/truncated recall as degraded,
- passes reference-only context regressions,
- has explicit credentials/config and approval for any install or persistent service.

## Final Verification

Run:

```bash
bun test test/memory-candidates.test.ts test/memory-candidate-adapters.test.ts test/memory-shadow.test.ts test/memory-context.test.ts test/memory-router.test.ts test/memory-eval.test.ts --preload ./test/preload.ts
bunx tsc --noEmit
bun run build
```

Expected: all pass.

## Stop Conditions

Stop and report if:
- an external candidate requires credentials or install approval,
- a change would enable a new live memory writer,
- a candidate needs network services running persistently,
- tests reveal current production injection can be steered by reference-only memory context.
