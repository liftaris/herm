# Herm Theme Discipline

Herm UI code names intent first. A component should ask for the role it is painting; the theme layer decides which concrete color that role uses in each installed theme.

Keep the current theme contract working. Existing JSON themes, `ThemeCurrent` fields, plugin access through `api.theme.current`, and resolver fallbacks stay supported. Semantic roles are an additive layer over resolved theme tokens, not a reason to rewrite theme palettes or copy another tool's visual style.

## Identity

Herm themes should preserve the app's own visual language: monochrome liminal space, Greek herm/pillar motifs, and retro-CGI grid restraint. Accents can vary by theme, but the UI should still read as Herm. Do not justify a color choice by matching another product.

## Role categories

Use role names tied to Herm UI behavior:

- chrome: app frame, sidebar pillar, tab bars, footers, separators
- pane: pane background, focused border, unfocused border, subtle divider
- row: selected, hovered, current, disabled, archived
- text: primary, muted, inverted-on-selection, link, heading, code
- action: primary, secondary, destructive, warning, success, info
- message: user, assistant, tool, system, thinking, timestamp, metadata
- diff: added, removed, context, hunk, line number, inline highlight
- markdown and syntax: rendered markdown and code-token roles
- herm: avatar/bust glyph, pillar border, Greek/grid ornament

A semantic role maps to existing concrete tokens such as `theme.primary`, `theme.border`, `theme.backgroundElement`, `theme.textMuted`, `theme.error`, `theme.success`, `theme.diffAdded`, or `theme.markdownHeading`. Each theme may map those concrete tokens to different RGBA values.

## Usage

Acceptable:

```tsx
<box borderColor={roles.pane.focusedBorder} />
<box backgroundColor={roles.row.selectedBg} />
<text fg={roles.text.muted}>empty</text>
<text fg={roles.action.danger}>delete</text>
```

Also acceptable while the semantic layer is being introduced:

```tsx
<box borderColor={theme.primary} />
<box backgroundColor={theme.backgroundElement} />
<text fg={theme.textMuted}>empty</text>
```

Do not scatter raw colors through UI code when a role token exists:

```tsx
<text fg="#67e8f9">active</text>
```

Raw colors belong in theme JSON, tests that deliberately encode fixtures, or rare one-off rendering code with a specific reason. New UI surfaces should prefer role tokens; compatibility code may continue to use `ThemeCurrent` fields until migrated deliberately.

## Contributor rule

When adding UI, choose the closest existing role. Add a new role only when the UI state is meaningfully different from the existing categories. Keep all installed themes renderable, preserve optional resolver fallbacks such as `backgroundMenu` and `selectedListItemText`, and avoid broad mechanical replacements that change visuals without review.
