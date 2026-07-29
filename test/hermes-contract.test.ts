import { describe, expect, test } from "bun:test"
import { HERMES_MANIFEST } from "../src/compat/hermes-manifest"
import { SCHEMA_SOURCE_REVISION } from "../src/config/schema"

const root = new URL("../", import.meta.url)

describe("Hermes compatibility source", () => {
  test("all committed producer artifacts use the declared pin", async () => {
    const contract = await Bun.file(new URL("hermes.contract.json", root)).json() as { pinned: string }
    expect(SCHEMA_SOURCE_REVISION).toBe(contract.pinned)
    expect(String(HERMES_MANIFEST.provenance.sourceRevision)).toBe(contract.pinned)
    for (const name of ["config.json", "gateway-events.json", "session-info.json"]) {
      const fixture = await Bun.file(new URL(`test/fixtures/hermes/${name}`, root)).json() as {
        metadata: { source_revision: string; producer_manifest: string }
      }
      expect(fixture.metadata.source_revision).toBe(contract.pinned)
      expect(fixture.metadata.producer_manifest).toBe("src/compat/hermes-manifest.ts")
    }
  })
})
