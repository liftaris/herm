import { test, expect } from "bun:test"
import { useEffect, useState } from "react"
import { mountNode, until } from "./harness"
import { useCommand } from "../src/ui/command"

// Regression for CommandProvider.register + the setRevision-in-cleanup
// commit loop (crash evidence: frames-t_54496e18/CRASH-theme-picker).
// Before the fix, a caller whose register effect's deps changed mid-
// commit (theme context flipping during DialogSelect onMove) would
// tear down + re-run its register, and the setState inside cleanup
// rescheduled CommandProvider during its own commit phase → Maximum
// update depth exceeded.
//
// This test hits the same shape synthetically: a parent that flips
// state in a layout effect (forcing a re-render while passive unmount
// is draining), a child that (un)registers on every parent render.
// With the fix the registry is ref-backed and (un)register is a plain
// Map write — no React state writes, no commit storm.

function Noisy() {
  const [n, setN] = useState(0)
  const cmd = useCommand()

  // Each render has a fresh dep → cleanup fires every commit.
  useEffect(() => cmd.register([
    { title: `cmd-${n}`, value: `v-${n}`, onSelect: () => {} },
  ]), [cmd, n])

  // Trigger a burst of re-renders. The cleanup fires during commit
  // for each one — the old bug's worst case.
  useEffect(() => {
    if (n < 30) queueMicrotask(() => setN(x => x + 1))
  }, [n])

  return null
}

test("register/unregister during rapid commit does not loop", async () => {
  await using t = await mountNode(<Noisy />)
  // If the loop returned, mount would throw before settle completes.
  await until(t, () => true)
  expect(t.frame()).toBeTruthy()
})

test("register returns unsubscribe; post-unsubscribe palette lookup empty", async () => {
  let disposed = false
  function Probe() {
    const cmd = useCommand()
    useEffect(() => {
      const off = cmd.register([{ title: "One", value: "one", onSelect: () => {} }])
      off()
      disposed = true
    }, [cmd])
    return null
  }
  await using t = await mountNode(<Probe />)
  await until(t, () => disposed)
  expect(disposed).toBe(true)
})

// Caller shape that triggered the original crash: a register effect
// whose deps include a context value that flips rapidly (the slash.tsx
// pattern, where themeCtx is a dep). If setRevision is ever re-added
// inside register()'s cleanup, this path recreates the commit storm.
test("register effect with a churning dep does not crash CommandProvider", async () => {
  function Churn() {
    const cmd = useCommand()
    const [dep, setDep] = useState(0)
    // A long burst of parent renders — each flips dep, each makes
    // the register-effect tear down + re-register. With the fix this
    // is just a bunch of Map writes; with the old setRevision path
    // the cumulative setStates trip the nested-update limit.
    useEffect(() => {
      let i = 0
      const tick = () => {
        if (i++ > 60) return
        setDep(x => x + 1)
        queueMicrotask(tick)
      }
      tick()
    }, [])
    useEffect(() => cmd.register([
      { title: `t${dep}`, value: `v${dep}`, onSelect: () => {} },
    ]), [cmd, dep])
    return null
  }
  await using t = await mountNode(<Churn />)
  await until(t, () => true)
  expect(t.frame()).toBeTruthy()
})
