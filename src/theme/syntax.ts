import { SyntaxStyle, type NativeResourceOwner, type ThemeTokenStyle } from "@opentui/core"
import type { Theme } from "./types"

export function syntax(theme: Theme, owner: NativeResourceOwner): SyntaxStyle {
  return SyntaxStyle.fromTheme(rules(theme), owner)
}

function rules(theme: Theme): ThemeTokenStyle[] {
  return [
    { scope: ["default"], style: { foreground: theme.text } },
    { scope: ["comment", "comment.documentation"], style: { foreground: theme.syntaxComment, italic: true } },
    { scope: ["string", "symbol"], style: { foreground: theme.syntaxString } },
    { scope: ["number", "boolean"], style: { foreground: theme.syntaxNumber } },
    { scope: ["keyword"], style: { foreground: theme.syntaxKeyword, italic: true } },
    { scope: ["keyword.return", "keyword.conditional", "keyword.repeat"], style: { foreground: theme.syntaxKeyword, italic: true } },
    { scope: ["keyword.type"], style: { foreground: theme.syntaxType, bold: true } },
    { scope: ["keyword.function", "function.method"], style: { foreground: theme.syntaxFunction } },
    { scope: ["function", "function.call"], style: { foreground: theme.syntaxFunction } },
    { scope: ["variable", "variable.parameter"], style: { foreground: theme.syntaxVariable } },
    { scope: ["type"], style: { foreground: theme.syntaxType } },
    { scope: ["operator"], style: { foreground: theme.syntaxOperator } },
    { scope: ["punctuation", "punctuation.bracket", "punctuation.delimiter"], style: { foreground: theme.syntaxPunctuation } },
    // Markdown-specific
    { scope: ["markup.heading"], style: { foreground: theme.markdownHeading, bold: true } },
    { scope: ["markup.strong"], style: { foreground: theme.markdownStrong, bold: true } },
    { scope: ["markup.italic"], style: { foreground: theme.markdownEmph, italic: true } },
    { scope: ["markup.link"], style: { foreground: theme.markdownLink, underline: true } },
    { scope: ["markup.raw"], style: { foreground: theme.markdownCode } },
    { scope: ["markup.list"], style: { foreground: theme.markdownListItem } },
  ]
}
