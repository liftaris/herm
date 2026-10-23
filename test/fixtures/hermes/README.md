# Hermes producer-derived compatibility fixtures

Source revision: c78ca093aa4b6759c055c3ed2bfbe7f741cf0292
Generation command: bun scripts/gen-hermes-fixtures.ts --agent-root <producer-root>

These fixtures use the shared static schema extractor and committed producer manifest for one explicit Hermes root.
Complete producer inputs and capability provenance live in src/compat/hermes-manifest.ts.
The generator never imports producer modules, starts the gateway, or reads Hermes user state.
