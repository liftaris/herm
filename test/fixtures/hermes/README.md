# Hermes producer-derived compatibility fixtures

Source revision: c8f866c48f44bb07f74b06dec80efe78093ea058
Generation command: bun scripts/gen-hermes-fixtures.ts --agent-root <producer-root>

These fixtures use the shared static schema extractor and committed producer manifest for one explicit Hermes root.
Complete producer inputs and capability provenance live in src/compat/hermes-manifest.ts.
The generator never imports producer modules, starts the gateway, or reads Hermes user state.
