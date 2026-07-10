---
title: "U3: Media image fallback chain"
type: feat
status: active
date: 2026-06-11
---

# U3: Media image fallback chain

## Scope

Implement the transcript/composer image preview decision chain for Herm only:

1. Chafa symbol preview when the image file is supported and `chafa` can render it;
2. media/file chip for every unsupported, missing, permission-denied, timeout, or no-capability path.

Explicit exclusions: no new gateway RPCs, no raw inline escape output, no broad composer/layout redesign, no Docker/portability/sidebar/OpenTUI-upgrade work.

## Research findings

- `ChafaImage` currently checks `chafaBin()` and calls `renderChafa()` directly, then falls back to `MediaChip` on failure.
- `MediaChip.classify()` is extension-only and treats remote image URLs as `url`, which is correct for a chip fallback but means local preview decisions must use local file support checks.
- Composer and transcript both render local image previews through `ChafaImage`, so extracting strategy selection there gives shared behavior without touching unrelated composer layout.
- OpenTUI has no safe terminal image primitive in this repo. Native image protocol escape output would bypass renderer ownership over redraw, scrollback, and copy behavior. Actual runtime should therefore not emit native previews, and this branch should not keep a native strategy surface.

## Implementation plan

1. Add `src/utils/terminal-image.ts` with pure helpers:
   - supported image extension check;
   - `previewStrategy(input)` returning `chafa` or `chip` plus reason.
2. Improve `src/utils/chafa.ts` host-tool handling:
   - use `Bun.which("chafa")` before fixed paths when available;
   - export a test-only/reset helper only if needed for stable tests;
   - keep all chafa failures as `{ err }` so callers never render error chrome.
3. Update `src/ui/ChafaImage.tsx` to call the shared strategy helper before rendering.
   - Missing/unsupported/non-local paths go directly to `MediaChip`.
   - Chafa render failure falls back to `MediaChip`.
4. Keep `MediaChip` as the universal final fallback and export reusable image extension support if it belongs there after implementation.
5. Add tests before production changes:
   - capability matrix chafa > chip;
   - unsupported/missing/non-local paths choose chip;
   - ChafaImage missing/unsupported path shows chip without error chrome;
   - composer/transcript surfaces continue sharing ChafaImage fallback behavior.
6. Run focused tests, full `bun test`, and `bunx tsc --noEmit`.
7. Run code review/autofix before commit, persist changes, push `feat/media-fallback-chain`, open PR to `dev`, and watch CI.

## Verification commands

- `bun test test/chafa.test.ts test/chafa-image.test.tsx test/media.test.tsx test/attachments.test.tsx`
- `bun test`
- `bunx tsc --noEmit`

## Risks

- Native preview remains modeled but not rendered until OpenTUI exposes a safe owner path; this is intentional to avoid raw escape output.
- Existing host-gated real Chafa fixture depends on local `~/Pictures/ko-fi_banner.png` and should skip cleanly when missing.
