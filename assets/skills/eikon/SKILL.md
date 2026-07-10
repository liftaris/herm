---
name: eikon
description: Use when helping a user create, edit, install, activate, update, remove, or share a Herm eikon through the built-in Eikon tab or the `herm eikon` CLI.
tags: [eikon, avatar, herm]
related_skills: [eikon-create]
---

# Building and managing eikons in Herm

An eikon is a 48×24 monochrome text avatar. It lives in the active
Hermes profile, normally:

    ~/.hermes/eikons/<name>/
      <name>.eikon      packed NDJSON — written by Studio on Ctrl+S / Ctrl+U
      studio.json       Studio's workspace state
      source/           base.<ext>, <state>.<ext>

You do **not** write `.eikon` or `studio.json`. Studio does.

## Where the user does the work

Herm's built-in **Eikon** tab has **Library / Catalog / Studio**:

- **Library** — local and bundled eikons; use, edit, update, share, delete,
  and New/install entry points.
- **Catalog** — shared catalog; install runtime-only, install with source,
  use installed eikons, download source, uninstall, or delist when eligible.
- **Studio** — edit an existing local/source draft eikon and bake it.

Tell the user: "open the Eikon tab"; `/library`, `/catalog`, and `/studio`
jump directly to the Eikon sub-tabs. In Studio:

- `eikon` row → pick an eikon, `+ New…`, or `+ Install…`
- `source` row → local/downloaded source; Generate rows appear only when the
  corresponding Hermes generation backend is configured
- `input` section → contrast / invert / flip (pixel-domain, shared)
- `<rasterizer>` section → rasterizer-specific glyph knobs, e.g. chafa
  symbols/fill/dither or native symbols
- Preview pane → wheel pans Y, Shift+wheel pans X, Ctrl+wheel zooms; drag the
  pan bars to scrub pan
- **Ctrl+S** bakes all six states without changing the active avatar
- **Ctrl+U** bakes all six states and uses it as the active avatar
- `u` in Studio opens the Submit eikon dialog; `s` in Library opens Share to
  catalog for local unpublished eikons

## What makes a good source

One line, once: **48×24, one color. Light subject on black, high contrast,
strong silhouette.** Fine detail disappears; outline is everything.

## When to do what

| user says | you do |
|---|---|
| "make me an eikon of X" | Load `eikon-create` and follow it. |
| drops an image path | Copy it to `${HERMES_HOME:-$HOME/.hermes}/eikons/<name>/source/base.<ext>` or use Library → New… → local file, then Studio → `eikon` row → `<name>`. |
| "edit my <name> eikon" | "Eikon → Studio → `eikon` row → `<name>`." |
| "install/shared catalog eikon" | "Eikon → Catalog" or `/catalog`. Choose Eikon only or Eikon + Source, then Use when ready. |
| "install from GitHub / URL / dir" | "Studio → `eikon` row → `+ Install…`", "Library → New… → inspect/install", or `herm eikon install <name|url|dir>`. |
| "too dark / washed out" | "invert toggle, then contrast slider — under `input`." |
| "off-center / too small" | "Ctrl+wheel zooms; wheel/Shift+wheel pans; drag pan bars for precise pan." |
| "make it move" | `eikon-create` §5 (video), or Studio's `source` row → Generate video… if available. |
| "publish/share my eikon" | "After baking, press `u` in Studio or `s` in Library. Review metadata, bundle, and GitHub PR target before submitting." |
| "remove from official catalog" | Use Catalog → Delist from Registry when eligible, or `herm eikon delist <name|id>`. |

## Install and manage shared eikons

For catalog eikons, use **Eikon → Catalog**. Rows show source,
compatibility, trust (`Verified`, `Unverified`, or `Mismatch`), digest,
and installed/active state. Catalog installs fetch built package artifacts;
they do not clone creator repos.

Default install is **Eikon only**: runtime package, no activation, no editable
source. Choose **Eikon + Source**, or later **Download Source**, when the user
wants to edit it in Studio.

For direct sharing, use `github.com/user/repo/eikon-name` for a multi-eikon
GitHub catalog repo, `github.com/user/repo` for a single-package repo, a git or
HTTP URL, or a local package directory. Private GitHub repos use normal git
authentication.

The local lifecycle is explicit:

```bash
herm eikon search [query] [--json]
herm eikon browse [query] [--json]
herm eikon inspect <name|url|dir> [--json]
herm eikon install <name|url|dir> [--name N] [--no-source] [--active-ok] [--json]
herm eikon list [--json]
herm eikon use <name> [--json]
herm eikon info <name> [--json]
herm eikon update <name> [--active-ok] [--json]
herm eikon remove <name> [--active-ok] [--json]
herm eikon delist <name|id> [--json]
```

`install` does not activate. If the installed name is currently active,
installing replaces the active avatar's backing package and requires
`--active-ok`. `use` activates. Updating or removing the active eikon also
requires `--active-ok`.

Creators share through normal GitHub repositories. For official registry
listing, use `u` in Studio or Library → Share to catalog after baking: Herm
runs registry preflight, asks for title/author/description/glyph, previews the
public bundle, then creates a GitHub PR through local `gh` auth or gives manual
PR instructions.
Use upstream `eikon pack`, `eikon index`, and `eikon manifest` for
direct-install repos. `eikon publish` is the lower-level GitHub PR contribution
helper for the configured/default catalog repo, not a hosted account, upload,
dashboard, or moderation flow.

Browser catalog surfaces such as `eikon.liftaris.dev` are discovery-only: they
preview catalog entries and give copyable `herm eikon install …` instructions.
Do not imply a browser click installs, activates, authenticates, or mutates Herm.

## Quick poster

To show a candidate in chat without Studio:

```bash
chafa --size=48x24 --symbols=braille --colors=none --format=symbols --stretch "<path>"
```

Preview-only; Studio's output will differ because it tone-maps first.

## Don'ts

- Don't hand-write `.eikon` NDJSON.
- Don't pick knob values for the user. Name the knob.
- Don't repeat the 48×24 brief.
- Don't say install activates. Install only writes the local package; Use
  activates.
- Don't describe hosted marketplace accounts, upload tokens, dashboards, or
  browser-native install flows for the v1 registry.
