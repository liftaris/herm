# Hermes producer-derived compatibility fixtures

Source revision: 4da7b9ee029c6ece2eb7992fc27dbcd086982c84
Generation command: bun scripts/gen-hermes-fixtures.ts --agent-root <producer-root>

These fixtures use the shared static schema extractor and committed producer manifest for one explicit Hermes root.
Complete producer inputs and capability provenance live in src/compat/hermes-manifest.ts.
The generator never imports producer modules, starts the gateway, or reads Hermes user state.
