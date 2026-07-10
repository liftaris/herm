---
name: eikon-create
description: Use when generating or adopting source images/videos for a Herm eikon so Eikon Studio can tune, bake, and optionally share it.
tags: [eikon, avatar, image-gen, video-gen, herm]
related_skills: [eikon]
---

# /eikon-create — generate eikon source files interactively

You are producing **source files**, not the packed `.eikon`. Studio owns
crop, tone (contrast/invert/flip), rasterizer choice, and baking. Your
deliverable is one or more images/videos under the active Hermes profile:

    ~/.hermes/eikons/<name>/source/

Studio resolves `base.*` for the default source and `<state>.*` for
per-state overrides (`idle listening thinking speaking working error`).
Direct `source/` discovery supports `png jpg jpeg webp gif bmp mp4 webm mov
mkv`; Studio's Local file picker currently accepts `png jpg jpeg webp gif mp4
webm mov`, so copy `bmp`/`mkv` into `source/` manually if needed.

Studio bakes with **Ctrl+S** without activation; **Ctrl+U** bakes and uses the
eikon as the active avatar.

## What survives rasterization

Output is 48×24, one theme color, braille/block glyphs. The one-line brief
(say once, don't repeat):

> 48×24, one color. Best results: light subject on black background, high
> contrast, strong silhouette.

Outline carries everything — facial detail, fine texture, and tonal gradients
mostly vanish.

## What Studio fixes for you (don't regenerate for these)

Studio adjusts these live on any source without a new generation:

- **Aspect / framing** — Studio crops to a square window; zoom + pan pick
  which square. A 16:9 or portrait source is fine.
- **Contrast** — slider, mean-centered. Flat or over-bright sources are
  usually salvageable.
- **Invert** — light↔dark swap. A dark-subject-on-light source works with
  invert off.
- **Flip** — horizontal/vertical mirror.

So: regenerate for **subject, pose, silhouette, background clutter**. Don't
regenerate for **crop, exposure, polarity, orientation**.

## Flow

### 0. Name

If the user passed an argument (`/eikon-create <name>`), slug it (lowercase,
`[^a-z0-9-]` → `-`, collapse runs, trim). Otherwise ask once. Make the folder
immediately so Studio's picker lists it:

```bash
n="<slug>"; mkdir -p "${HERMES_HOME:-$HOME/.hermes}/eikons/$n/source"
```

### 1. Subject

Ask what the eikon is. One line is enough. If they drop an image instead of
describing one, skip to §3 adopt-only.

### 2. Generate base

Call `image_generate` with the subject on line 1 and Studio's fixed style hint
on line 2:

```text
<subject>, close-up portrait emphasizing the face/head, looking slightly left, stark black and white, bold silhouette, simple uncluttered shape
high contrast, light subject on dark, black background
```

Keep this general: replace `face/head` with the subject's most readable feature
if it is not a character or creature. Prefer `aspect_ratio="square"` if the
tool takes it; if it doesn't, don't worry — Studio crops.

After every candidate, adopt it into `source/base.<ext>` before handoff or
iteration. Show the result inline with `![base](<path>)` and a 48-wide terminal
preview:

```bash
chafa --size=48x24 --symbols=braille --colors=none --format=symbols --stretch "<path>" 2>/dev/null || true
```

Ask: **keep, regenerate, or adjust?** On adjust, fold their note into the
subject line and leave the style hint alone. If two rounds fail on background
clutter, silently append `, isolated on pure black, no floor, no environment`
and try again.

Overwrite the same role file (`base.<ext>` for the default source,
`<state>.<ext>` for overrides) so candidates do not drift across filenames. If
Studio is already open after an external write, tell the user to press reload
(`r`) or reopen the eikon; dirty drafts must be saved or reverted before reload.
A candidate left only in temp/cache or in an unselected filename is invisible.

### 3. Adopt

Use this for generated files, downloaded URLs, or a user-supplied local path.
Set `role=<state>` for per-state overrides; default is `base`.

```bash
role="${role:-base}"
src="<path-or-downloaded-tmp>"
base="${src##*/}"
ext="${base##*.}"
[ "$ext" = "$base" ] && ext="png"
ext=".${ext,,}"
case "$ext" in .png|.jpg|.jpeg|.webp|.gif|.bmp|.mp4|.webm|.mov|.mkv) ;; *) ext=".png" ;; esac
dst="${HERMES_HOME:-$HOME/.hermes}/eikons/$n/source/$role$ext"
cp "$src" "$dst" && ls -l "$dst"
```

URL return → download to `/tmp/<n>-<role>.<ext>` first, preserving the media
extension when known. Ambiguous image URL → `.png`; ambiguous video URL → `.mp4`.

### 4. Per-state sources (optional)

Base covers all six states by default. If the user wants distinct ones, repeat
§2–3 per state, saving as `<state>.<ext>`. Nudge the subject line with pose
intent:

| state | pose nudge |
|---|---|
| listening | head turned slightly toward viewer |
| thinking | head tilted back, contemplative |
| speaking | mouth open mid-word |
| working | head bowed forward |
| error | recoiling, startled |

### 5. Video (optional, only if asked)

Use `video_generate` if available. Studio's Generate video row appears only
when the installed Hermes Agent video backend passes its requirement check; this
skill may also use any available agent `video_generate` tool. If video generation
is unavailable, adopt a local file or URL result instead.

Before prompting motion for a character/creature, establish a one-line persona:
temperament, bearing, and what an "idle" moment means for this subject. It keeps
motion specific instead of generic breathing/bobbing.

Motion discipline: animate only what the user asked for. Do not add ambient
breathing, swaying, shimmer, cloth ripple, or body motion unless requested;
small artifacts become obvious at 48×24. Prefer one deliberate motion plus one
blink over many tiny movements. Put unwanted motion in the negative prompt or
prompt body when the provider supports it.

What matters for an eikon video source:

- **Duration** — 1–4 s; Studio defaults to 2 s. Longer usually inflates the
  bake without improving readability.
- **Aspect** — prefer 1:1 if accepted; otherwise use an accepted aspect and let
  Studio crop.
- **Resolution** — low is fine; the target is 48×24. Don't ask for HD.
- **Start image** — if the tool accepts it, pass `base.*` / the effective idle
  source as `image_url` so frame 0 anchors on the still pose. Studio's current
  bridge does not provide an end-frame handoff; skip unsupported knobs.
- **Loop** — useful but not required. If the provider has loop/seamless flags,
  set them; otherwise do not chase a perfect loop by prompting.
- **Model tier** — if a lite/fast tier warps the subject, switch to a better
  tier if the tool exposes `model=`. Don't burn iterations fighting artifacts a
  tier bump fixes.

Providers vary. **Pass what the tool accepts, skip what it doesn't, and don't
apologize for the gaps.** None of them block a usable eikon.

Adopt as `<state>.mp4` (or `base.mp4` for an animated idle).

### 6. Hand off

Once source files are in place:

> Open **Eikon → Studio** → `eikon` row → **<name>**. Tune zoom / contrast /
> invert / symbols there, then **Ctrl+S** to bake or **Ctrl+U** to bake and use.
> After a saved bake, press `u` in Studio for the Submit eikon dialog or `s` in
> **Library** for Share to catalog; Herm previews the bundle and GitHub PR target
> before submission.

Stop there. Studio writes `<name>.eikon` and `studio.json`.

## Don'ts

- Don't write `.eikon` or `studio.json`.
- Don't pick contrast, invert, zoom, or rasterizer values — name the knob, the
  user turns it in Studio.
- Don't regenerate for things Studio can fix (see table above).
- Don't enumerate provider capabilities to the user; just use what's there.
- Don't repeat the 48×24 brief.
