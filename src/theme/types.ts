import type { RGBA } from "@opentui/core";

/** All color token names (excludes thinkingOpacity) */
export type ThemeColor = Exclude<keyof ThemeCurrent, "thinkingOpacity">;

/** Resolved theme — all values are RGBA or number, ready for rendering */
export type ThemeCurrent = {
  // Core
  readonly primary: RGBA;
  readonly secondary: RGBA;
  readonly accent: RGBA;
  readonly error: RGBA;
  readonly warning: RGBA;
  readonly success: RGBA;
  readonly info: RGBA;

  // Text
  readonly text: RGBA;
  readonly textMuted: RGBA;
  readonly selectedListItemText: RGBA;

  // Backgrounds
  readonly background: RGBA;
  readonly backgroundPanel: RGBA;
  readonly backgroundElement: RGBA;
  readonly backgroundMenu: RGBA;

  // Borders
  readonly border: RGBA;
  readonly borderActive: RGBA;
  readonly borderSubtle: RGBA;

  // Diff
  readonly diffAdded: RGBA;
  readonly diffRemoved: RGBA;
  readonly diffContext: RGBA;
  readonly diffHunkHeader: RGBA;
  readonly diffHighlightAdded: RGBA;
  readonly diffHighlightRemoved: RGBA;
  readonly diffAddedBg: RGBA;
  readonly diffRemovedBg: RGBA;
  readonly diffContextBg: RGBA;
  readonly diffLineNumber: RGBA;
  readonly diffAddedLineNumberBg: RGBA;
  readonly diffRemovedLineNumberBg: RGBA;

  // Markdown
  readonly markdownText: RGBA;
  readonly markdownHeading: RGBA;
  readonly markdownLink: RGBA;
  readonly markdownLinkText: RGBA;
  readonly markdownCode: RGBA;
  readonly markdownBlockQuote: RGBA;
  readonly markdownEmph: RGBA;
  readonly markdownStrong: RGBA;
  readonly markdownHorizontalRule: RGBA;
  readonly markdownListItem: RGBA;
  readonly markdownListEnumeration: RGBA;
  readonly markdownImage: RGBA;
  readonly markdownImageText: RGBA;
  readonly markdownCodeBlock: RGBA;

  // Syntax
  readonly syntaxComment: RGBA;
  readonly syntaxKeyword: RGBA;
  readonly syntaxFunction: RGBA;
  readonly syntaxVariable: RGBA;
  readonly syntaxString: RGBA;
  readonly syntaxNumber: RGBA;
  readonly syntaxType: RGBA;
  readonly syntaxOperator: RGBA;
  readonly syntaxPunctuation: RGBA;

  // Numeric
  readonly thinkingOpacity: number;
};

/** Herm-specific tokens — the sidebar "pillar" identity */
export type HermTokens = {
  /** Avatar (bust) glyph color — top of the herm; also the pillar border */
  readonly hermAvatar: RGBA;
};

/** Internal resolved theme with extra tracking + herm tokens */
export type Theme = ThemeCurrent &
  HermTokens & {
    _hasSelectedListItemText: boolean;
  };

/** Color value in a theme JSON file */
export type HexColor = `#${string}`;
export type RefName = string;
export type Variant = { dark: HexColor | RefName; light: HexColor | RefName };
export type ColorValue = HexColor | RefName | Variant | RGBA;

/** Theme JSON file format */
export type ThemeJson = {
  defs?: Record<string, HexColor | RefName>;
  theme: Omit<
    Record<ThemeColor, ColorValue>,
    "selectedListItemText" | "backgroundMenu"
  > & {
    selectedListItemText?: ColorValue;
    backgroundMenu?: ColorValue;
    thinkingOpacity?: number;
  };
};
