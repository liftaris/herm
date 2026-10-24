# Test harness guide

## Choosing the test tier

- Pure helpers/reducers: import the function directly; no renderer.
- `~/.hermes` readers/writers: use `tmpHome()` from `test/fixture/home`.
- Component UI: use `mountNode()`; no global `useAppKeys` routing.
- Shell/user flows: use `mount()` so app key routing and dialogs run.
- Real process/CONTROL checks: use a sized pty + `/frame`; keep out of
  default unit coverage unless explicitly scoped.
- Required Chafa/FFmpeg contracts execute in CI, which installs both tools.
  Keep genuinely optional host smoke checks outside the required suite; never
  gate contract coverage on a personal-machine fixture.

## Test quality contract

New or materially changed regression tests must name the durable user,
protocol, persistence, security, lifecycle, geometry, or performance
contract they protect and the plausible production fault they detect.
Choose the lowest tier that can observe that fault: direct implementation
first, focused provider/component second, and a full shell only when routing
or cross-layer ownership is the behavior.

Use this rubric when reviewing an existing case:

- **Retain** when it exercises real implementation, observes a durable
  contract, and can fail for a plausible production defect.
- **Rewrite** when the contract matters but the case observes copy, timing,
  private instrumentation, a permissive fake, or an oversized shell path.
- **Delete** when it only logs diagnostics, compares an expression with
  itself, mirrors implementation/source text, protects removed UI, or
  duplicates stronger coverage.

Exact strings are appropriate for protocol bytes, CLI/API output, persisted
formats, terminal escapes, and intentionally locked geometry. Ordinary UI
labels and prose are not contracts unless explicitly locked. Generated
outputs may be checked as artifacts when generation is the contract; do not
read handwritten production TypeScript to infer behavior.

Run `bun run test:check` for a report-only full-tree hygiene scan. Run
`bun run test:check:strict` for the zero-tolerance full-tree CI gate. Run
`bun run test:check:changed <base>` with an explicit git diff base to enforce
the high-confidence rules on changed test files. The checker only catches
mechanical slop; it does not judge semantic assertion quality, duplicate
coverage, copy contracts, or test-count ratios.

## Mount

```ts
import { mount, mountNode, until, MockGateway } from "./harness"

// Full app under test renderer. gw.start() fires automatically via
// render() → settle() → settle().
await using t = await mount({ handlers: { "foo.bar": p => ({...}) } })
await until(t, () => t.frame().includes("Ready"))

// Arbitrary subtree wrapped in all providers (for component tests).
const ref = createRef<FooHandle>()
await using t = await mountNode(<Foo ref={ref} />, { gw })
```

`await using` → `[Symbol.asyncDispose]` destroys the renderer on
block exit. Omit and call `t.destroy()` manually if you need to assert
after cleanup.

## Home fixtures

```ts
import { tmpHome } from "./fixture/home"

await using h = await tmpHome({
  config: { memory: { provider: "mem0" } },
  files: { "memories/MEMORY.md": "one" },
  prefs: { theme: "tokyonight" },
})
```

`tmpHome()` creates a fresh `HERMES_HOME` and `HERM_CONFIG_DIR`, seeds
files, calls `rehome()`, and restores the previous env on dispose. Use it
for stateful service tests instead of sharing the preload sandbox. Dispose
it after any renderer using it (`await using h` before `await using t`) so
watchers close before the temp dir is removed.

`tmpHome()` rebinds process-global environment and service roots. Do not use
it from `test.concurrent`; stateful files must run serially unless their root
is injected rather than rebound. During refactors, run each changed stateful
file in a fresh test process as well as through the aggregate suite.

## MockGateway

- `new MockGateway({ "method": p => result })` — override any RPC.
  Direct instances default only `session.create`, `commands.catalog`, and
  `config.get`; every other RPC requires an explicit declaration. `mount()`
  and `mountNode()` apply a finite UI preset for renderer plumbing.
- `gw.on$("method", fn)` — add/override post-construction.
- Unknown methods reject and fail harness settlement/disposal by default, even
  when product code catches the rejection. Use `mode: "audit"` only while
  migrating inherited coverage; `mode: "compat"` is temporary diagnostics.
- `gw.expect$("method", fn, { match, max })` — require bounded traffic and
  validate parameters. Unused, mismatched, or duplicate calls fail disposal.
- `gw.allow$("method", fn, { match, max })` — explicitly permit bounded
  optional traffic. Do not add wildcard or catch-all handlers.
- `gw.push({ type: "message.delta", payload: {...} })` — emit event.
- `gw.last("method")` — most recent call or undefined.
- `gw.calls` — full call log.

## Driving input

```ts
await act(async () => { await t.keys.typeText("hello") })
act(() => t.keys.pressEnter())
act(() => t.keys.pressEscape())
act(() => t.keys.pressKey("c", { ctrl: true }))
act(() => t.keys.pressArrow("down"))
```

Always wrap in `act()`. Mouse: `t.mouse.pressDown(x, y)` (frame
coordinates, 0-indexed).

## Assertions

`t.frame()` returns the rendered screen as one newline-joined string.
Prefer `until(t, predicate)` over `await t.settle(); expect(...)` — it
settles first then polls, and times out with a frame dump on failure.

## Pitfalls

- **`HERMES_HOME` isolation**: `test/preload.ts` sets it to a mktemp
  per `bun test` run. Do NOT write one-off repro scripts that `import
  from "../src/"` without first setting `HERMES_HOME` — they resolve
  `~/.hermes` and clobber real user data.
- **settle() races**: two settles on mount handle the `effect → drain
  → state → second frame` sequence. Post-interaction, one `until()`
  usually suffices; chains of `act()` without settle between may batch.
- **Popover predicates**: `until(t, () => frame.includes("/clear"))`
  can match stale text from a *previous* frame if the predicate was
  already true. Write dialog-only predicates (e.g. wait for the
  dialog-specific string, not one that also appears in the popover).
- **mountNode ≠ useAppKeys**: global keyboard routing (tab switch,
  popover nav via Tab/↑/↓, Esc interrupt) lives in `useAppKeys` which
  only `mount()` wires. For `mountNode` component tests, drive the
  imperative handle (`ref.current.popAccept()`) instead of pressing
  keys that the shell would normally route.
- **kitty keyboard**: harness sets `kittyKeyboard: true` so
  `pressEscape()` is a clean single event (raw ESC is an arrow-key
  prefix and the parser waits).

## CI gates

CI and release use Bun `1.4.4`. The required pull-request gate runs the
high-confidence checker, full typecheck, normal full suite, and production
build in one job. Do not weaken these commands with source-only filtering.

Scheduled and manually dispatched CI runs the same job once more in randomized
order with a UTC-date seed. The log prints the exact replay command. Add a
discovered failing seed to local regression evidence until its state leak is
fixed; do not create a permanent overlapping job matrix.

Production fault mutations are local review evidence, not a CI lane. CI runs
only the restored tree. `MockGateway` remains strict by default in every gate.
