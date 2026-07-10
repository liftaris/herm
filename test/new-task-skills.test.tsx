import { describe, test, expect } from "bun:test"
import { act, useEffect } from "react"
import { mountNode, MockGateway, until } from "./harness"
import { useDialog } from "../src/ui/dialog"
import { openCreateTask, type Draft } from "../src/dialogs/new-task"

let resolved: Draft | null | undefined

const Opener = () => {
  const dialog = useDialog()
  useEffect(() => {
    resolved = undefined
    void openCreateTask(dialog, { assignees: ["builder", "reviewer"] })
      .then(v => { resolved = v })
  }, [])
  return null
}

// Walk the form from "title" down into the Skills field (under More).
// Form opens focused on Title; Tab walks visible fields in order. Settle
// between presses — without it multiple pressTab() in one microtask
// coalesce and only one field advance lands per frame.
async function walkToSkills(t: Awaited<ReturnType<typeof mountNode>>) {
  // Make sure the form is fully mounted and focused on Title before we
  // start tab-walking. Without this gate the first few Tab presses can
  // land before the dialog's useKeyboard hook has registered.
  await until(t, () => /▸ Title/.test(t.frame()))
  // Type a title so submit() passes validation later. Skills focus
  // doesn't route printables outside the form, so we type it here.
  for (const c of "hi") await act(async () => { await t.keys.typeText(c) })
  const tab = async () => { await act(async () => { t.keys.pressTab() }); await t.settle() }
  await tab(); await until(t, () => /▸ Body/.test(t.frame()))
  await tab(); await until(t, () => /▸ Assignee/.test(t.frame()))
  await tab(); await until(t, () => /▸ Priority/.test(t.frame()))
  await tab(); await until(t, () => /▸ Triage/.test(t.frame()))
  await tab(); await until(t, () => /▸ More/.test(t.frame()))
  // pressKey(" ") emits key.name === " " under kitty, but the form
  // handler checks key.name === "space" (how real terminals / typeText
  // deliver it). Use typeText to route through the "space" name.
  await act(async () => { await t.keys.typeText(" ") })
  await until(t, () => /More ▾/.test(t.frame()))
  await tab(); await until(t, () => /▸ Tenant/.test(t.frame()))
  await tab(); await until(t, () => /▸ Project/.test(t.frame()))
  await tab(); await until(t, () => /▸ Workspace/.test(t.frame()))
  await tab(); await until(t, () => /▸ Runtime/.test(t.frame()))
  await tab(); await until(t, () => /▸ Skills/.test(t.frame()))
}

describe("new-task Skills field", () => {
  test("typing filters → Tab commits highlighted match as a chip", async () => {
    const gw = new MockGateway({
      "skills.manage": p => p.action === "list"
        ? { skills: { devops: ["kanban-worker", "hermes-agent-skill-authoring"], software: ["plan"] } }
        : {},
    })
    const t = await mountNode(<Opener />, { gw, width: 120, height: 60 })
    await until(t, () => t.frame().includes("New Task"))
    await walkToSkills(t)
    await until(t, () => /▸ Skills/.test(t.frame()))
    // Type "plan" → one match; Tab commits.
    for (const c of "plan") await act(async () => { await t.keys.typeText(c) })
    // Match row shows: "  ▸          plan  software" — ▸ is in the 13-wide label column.
    await until(t, () => /plan\s+software/.test(t.frame()))
    await act(async () => { await t.keys.pressTab() })
    // After commit, filter clears and the match row disappears; only the chip remains.
    await until(t, () => !/plan\s+software/.test(t.frame()))
    // Commit: Ctrl+Enter from the Skills field submits.
    await act(async () => { t.keys.pressEnter({ ctrl: true }) })
    await until(t, () => resolved !== undefined)
    expect(resolved).not.toBeNull()
    expect(resolved!.skills).toEqual(["plan"])
    t.destroy()
  })

  test("Backspace on empty filter removes the last chip", async () => {
    const gw = new MockGateway({
      "skills.manage": () => ({ skills: { devops: ["kanban-worker"], software: ["plan"] } }),
    })
    const t = await mountNode(<Opener />, { gw, width: 120, height: 60 })
    await until(t, () => t.frame().includes("New Task"))
    await walkToSkills(t)
    await until(t, () => /▸ Skills/.test(t.frame()))
    // Add "plan" chip via filter + Tab.
    for (const c of "plan") await act(async () => { await t.keys.typeText(c) })
    await act(async () => { await t.keys.pressTab() })
    // Add "kanban" chip.
    for (const c of "kanban") await act(async () => { await t.keys.typeText(c) })
    await act(async () => { await t.keys.pressTab() })
    await t.settle()
    // Filter is empty now. Backspace should pop the last chip (kanban-worker).
    await act(async () => { await t.keys.pressBackspace() })
    await t.settle()
    // Submit and inspect the draft — more robust than regex on the frame,
    // since chip label collides with the "Title" placeholder glyph.
    await act(async () => { t.keys.pressEnter({ ctrl: true }) })
    await until(t, () => resolved !== undefined)
    expect(resolved!.skills).toEqual(["plan"])
    t.destroy()
  })

  test("filter buffer eats Backspace before popping chips", async () => {
    const gw = new MockGateway({
      "skills.manage": () => ({ skills: { s: ["plan"] } }),
    })
    const t = await mountNode(<Opener />, { gw, width: 120, height: 60 })
    await until(t, () => t.frame().includes("New Task"))
    await walkToSkills(t)
    await until(t, () => /▸ Skills/.test(t.frame()))
    // Add one chip.
    for (const c of "plan") await act(async () => { await t.keys.typeText(c) })
    await act(async () => { await t.keys.pressTab() })
    await t.settle()
    // Type "xyz" into the filter (no matches, but buffer grows).
    for (const c of "xyz") await act(async () => { await t.keys.typeText(c) })
    // Bksp erases filter char — chip must survive.
    await act(async () => { await t.keys.pressBackspace() })
    await act(async () => { await t.keys.pressBackspace() })
    await act(async () => { await t.keys.pressBackspace() })
    await t.settle()
    await act(async () => { t.keys.pressEnter({ ctrl: true }) })
    await until(t, () => resolved !== undefined)
    expect(resolved!.skills).toEqual(["plan"])
    t.destroy()
  })

  test("Tab with empty filter moves to next field (no match to commit)", async () => {
    const gw = new MockGateway({
      "skills.manage": () => ({ skills: { s: ["plan"] } }),
    })
    const t = await mountNode(<Opener />, { gw, width: 120, height: 60 })
    await until(t, () => t.frame().includes("New Task"))
    await walkToSkills(t)
    await until(t, () => /▸ Skills/.test(t.frame()))
    // Tab from empty Skills field should wrap to first field (title).
    await act(async () => { await t.keys.pressTab() })
    await until(t, () => /▸ Title/.test(t.frame()))
    t.destroy()
  })
})
