# Hermes compatibility procedure

Herm follows Hermes Agent. The compatibility process tells operators whether Herm
must change, whether an upstream change is intentionally out of scope, or whether
an executable report is asking for a new Herm feature.

## Responsibilities

Pinned compatibility is the release contract. Pull request CI clones
the repository and revision declared in `hermes.contract.json`, then runs
`HERMES_AGENT_ROOT=${root} bun run gen-schema:check` plus
`HERMES_AGENT_ROOT=${root} bun run gen-hermes-manifest:check` and
`HERMES_AGENT_ROOT=${root} bun run gen-fixtures:check`. Release CI checks the
same artifacts against the same pin. The committed schema, producer manifest,
capability policy, and fixtures must all report that revision. If a check fails,
either regenerate the stale artifact from the pinned source or intentionally
move the pin and review the drift below.

Current-canary compatibility is advisory. The scheduled and manually dispatched
`.github/workflows/current-hermes-canary.yml` runs
`bun run current-hermes-canary` against the requested Hermes ref and uploads its report.
It produces semantic config findings and a raw schema diff, classifying fetch
failures, generator failures, schema drift, and compatibility passes without
rewriting pinned artifacts. A canary may open a Herm feature ticket or feed a
planned pin bump, but it does not replace pinned CI or scheduled random-order
tests.

## Executable surfaces

Use executable commands and generated artifacts first; use source inspection only
where no generator covers the surface yet.

- Config schema: `bun run gen-schema:check`, `bun run gen-schema`,
  `scripts/gen-schema.ts`, `src/config/schema.ts`.
- Producer manifest: `bun run gen-hermes-manifest:check`,
  `bun run gen-hermes-manifest`, `scripts/hermes-source.ts`,
  `scripts/gen-hermes-manifest.ts`, and `src/compat/hermes-manifest.ts`. This
  single extraction owns gateway RPCs/events, session metadata, slash commands,
  TUI extras, and dynamic command classes.
- Semantic config drift: `bun run config-drift -- --pinned-root /path/to/hermes-agent`,
  `scripts/config-drift.ts`, and
  `src/config/semantics.ts`. Add `--current-root` and `--warn-current` for an
  advisory latest-upstream comparison.
- Capability coverage: `src/app/capabilityCoverage.ts`, validated as part of
  `gen-hermes-manifest:check` so every producer ID has one policy and rationale.
- Producer fixtures:
  `HERMES_AGENT_ROOT=/path/to/hermes-agent bun run gen-fixtures:check`,
  `scripts/gen-hermes-fixtures.ts`, and
  `test/fixtures/hermes/README.md`.
- Runtime backend contract: `src/context/backend-contract.ts`,
  `src/app/sessionCapabilities.ts`, and their gateway/app tests.
- Latest-Hermes canary: `bun run current-hermes-canary`,
  `scripts/current-hermes-canary.ts`, and
  `.github/workflows/current-hermes-canary.yml`.
- CI and release gates: `.github/workflows/ci.yml` and
  `.github/workflows/release.yml`.
- Test hygiene and gates: `bun run test:check:strict`, `bunx tsc --noEmit`,
  `bun test`, `bun run build`.
- Gateway methods: start from `GATEWAY_INVENTORY.rpc.diff`, then review local
  `gw.request(...)` calls and strict `MockGateway` handlers where the report
  names additions, removals, or likely renames.
- Gateway events: start from `GATEWAY_INVENTORY.events.diff`, then review
  `src/context/wire.ts`, `src/context/events.ts`, and gateway event tests for
  the affected names.
- Fixtures: review the fixture README beside each fixture set before accepting a
  producer-derived shape.

Prefer each `*:check` command and committed report over manual greps. Every
report must be produced from a named Hermes Agent source and fail closed on
unknown dynamic producer behavior.

## Review checklist

### Methods

1. Identify added, removed, or renamed Hermes gateway RPC methods from
   `HERMES_MANIFEST.gateway.rpc.diff`.
2. Compare each affected local `gw.request(` use with strict `MockGateway`
   coverage.
3. Unknown methods in tests are unsupported unless a test explicitly allows the
   bounded call and asserts the user-visible degradation.
4. Method drift that changes an operator-visible Hermes capability requires a
   Herm feature ticket unless Herm already declares that capability out of
   scope.

### Events

1. Identify added, removed, or renamed Hermes gateway events from
   `HERMES_MANIFEST.gateway.events.diff`.
2. Compare affected event names against the typed gateway event union and
   `mapEvent`.
3. Check whether the event persists transcript state, updates transient status,
   writes diagnostics, or calls a side callback.
4. Add or update tests for each durable behavior. Status-only or thinking-only
   events may remain transient when that is the declared Herm behavior.
5. Unknown producer event families require a feature ticket or an explicit
   unsupported classification; do not drop them silently.

### Contract version

1. Check `session.info.desktop_contract` against `MIN_BACKEND_CONTRACT` and
   `MAX_BACKEND_CONTRACT`. Missing, malformed, older, and newer contracts fail
   closed for mutating RPCs while boot and reviewed read methods remain usable.
2. Preserve source revision, version, release date, and update metadata from the
   same payload so failures identify the producer that emitted them.
3. Treat generated artifact headers as additional contract sources: Hermes
   Agent revision, config key count, RPC method count, and event count.
4. `_config_version` and other internal `_` keys are intentionally not surfaced
   in the Herm config schema.
5. A changed source revision, key count, approval mode set, RPC method count,
   event count, or no-internal-keys assertion is contract drift. Review it
   before committing regenerated output.

### Capability classifications

1. Run `gen-hermes-manifest:check` against the named producer. Every generated RPC,
   slash command, TUI extra, and dynamic slash class must have one explicit
   coverage policy and rationale; stale policies fail the check.
2. Distinguish structured RPC coverage, gateway slash fallback, local handling,
   plugin API coverage, intentional unsupported behavior, non-applicable
   behavior, and missing support. Do not infer coverage from matching names.
3. Session capability gates are local Herm behavior. Verify prompt submission,
   command dispatch, and queue drain semantics against `sessionCapabilities`
   tests.
4. Model capability shape in the current wire contract is only `fast?` and
   `reasoning?`. Do not infer broader provider capability support from upstream
   catalogs without a Herm feature change.
5. If upstream adds a capability that Herm can expose with existing UI semantics,
   open a Herm feature ticket. If it changes runtime ownership, leave it with
   Hermes Agent and document the boundary.

### Config semantics

1. Regenerate or check `src/config/schema.ts` against the pinned Hermes source.
2. Run `config-drift` to separate reproducible pinned drift from advisory
   current-upstream drift and inspect approval-mode changes separately.
3. Review type, default, group, and effect classification. Effects are operator
   promises: `live`, `session`, or `restart`.
4. Review write lanes separately from schema generation. Gateway-live aliases,
   YAML-only structured values, and CLI serialized writes have different failure
   modes.
5. Approval config comes from Hermes gateway server modes. Check modes, default,
   timeout, and the `approval_mode` live alias together.

### Fixtures

1. Run `gen-fixtures:check` with an explicit producer root and read the fixture
   README for producer revision, generation command, and isolation boundary.
2. Accept fixtures only when they preserve the producer shape that Herm consumes;
   synthetic values must not become behavioral claims.
3. If a fixture changes because Hermes changed its producer format, update the
   fixture, its README provenance, and the tests that consume it in the same
   change.

## Drift decisions

Intentional drift is a declared Herm boundary. Examples include transient status
or thinking events that should not become transcript rows, OpenCode config layers
Herm does not claim to import, or theme compatibility fields retained until a
deliberate migration. The declaration belongs in docs or tests beside the
surface.

Blocked drift is a change Herm refuses with an explicit failure. Structured
config values that must be edited in YAML mode and gateway-only config-file
modes are blocked, not missing support. The failure message and test are the
contract.

Unsupported drift is skipped or dropped behavior with a documented analogue gap.
OpenCode key IDs without a Herm action and strict unknown RPCs in tests are
unsupported until a feature ticket changes the contract.

Requires Herm feature ticket means upstream exposed operator-relevant behavior
that is not intentional, blocked, or unsupported. File the ticket with the
report, Hermes source revision, generated artifact path, and the Herm surface
that should own the UX. Do not implement unrelated Hermes runtime ownership in a
compatibility-doc update.

## Pin bump sequence

1. Update the repository or pinned revision in `hermes.contract.json`, then clone
   that exact source outside `~/.hermes` unless you intend to use the live install.
2. Run `HERMES_AGENT_ROOT=/path/to/hermes-agent bun run gen-schema:check`.
3. Run `HERMES_AGENT_ROOT=/path/to/hermes-agent bun run gen-hermes-manifest:check`.
4. Run `bun run config-drift -- --pinned-root /path/to/hermes-agent`.
5. Run `HERMES_AGENT_ROOT=/path/to/hermes-agent bun run gen-fixtures:check`.
6. If stale, run the corresponding generator and inspect
   `src/config/schema.ts`, `src/compat/hermes-manifest.ts`, the capability policy,
   and the producer fixtures together.
7. Apply the review checklist above for config, methods, events, capabilities,
   and fixtures touched by the same upstream change.
8. Run the same gates as CI for the touched surface. At minimum:
   `bun run test:check:strict`, `bunx tsc --noEmit`, `bun test`, and
   `bun run build`.
9. Commit generated artifacts and documentation together with the source revision
   evidence. Do not hand-edit generated files.
