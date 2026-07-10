import { useState, useMemo, memo } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import type { RGBA } from "@opentui/core"
import { cache, type Analytics as Data, type NameRow } from "../service/hermes-analytics"
import { useKeys } from "../keys"
import { useTheme } from "../theme"
import { useDialog } from "../ui/dialog"
import { Spinner } from "../ui/spinner"
import { TabShell } from "../ui/shell"
import { HintBar } from "../ui/hint"
import { Col, Hdr } from "../ui/table"
import { fmt, cost, trunc } from "../ui/fmt"
import { useAnalyticsData, type AnalyticsQuery } from "./analytics-data"

const BLOCKS = " ▁▂▃▄▅▆▇█"

// Multi-row vertical bar chart. Each column is one datum; each row is
// a vertical slice rendered bottom-up with 1/8-block glyphs, so a
// 7-row chart has 56 intensity levels — enough to see day-over-day
// movement that a single-row sparkline flattens.
const rows = (vals: number[], h: number): string[] => {
  const peak = Math.max(1, ...vals)
  const ticks = vals.map(v => Math.round((h * 8 * v) / peak))
  return Array.from({ length: h }, (_, r) => {
    const floor = (h - 1 - r) * 8
    return ticks.map(t => BLOCKS[Math.max(0, Math.min(8, t - floor))]).join("")
  })
}

const Chart = memo((p: { data: Data; h: number }) => {
  const theme = useTheme().theme
  const days = p.data.byDay
  const vals = days.map(d => d.cost)
  const peak = Math.max(...vals, 0.01)
  const axis = (v: number) => cost(v).padStart(7)
  const md = (s: string) => s.slice(5)   // yyyy-mm-dd → mm-dd
  return (
    <box flexDirection="column">
      {rows(vals, p.h).map((line, i) => (
        <box key={i} height={1} flexDirection="row">
          <box width={8} flexShrink={0}>
            <text fg={theme.textMuted}>
              {i === 0 ? axis(peak) : i === p.h - 1 ? axis(0) : ""}
            </text>
          </box>
          <text fg={theme.primary}>{line}</text>
        </box>
      ))}
      <box height={1} flexDirection="row">
        <box width={8} flexShrink={0} />
        <text fg={theme.textMuted}>
          {days.length > 0
            ? `${md(days[0].date)}${" ".repeat(Math.max(0, days.length - 10))}${md(days[days.length - 1].date)}`
            : ""}
        </text>
      </box>
    </box>
  )
})

// Ranked name+count list with horizontal bar. Shared by Tools/Sources.
const Rank = memo((p: { title: string; rows: NameRow[] | null; fg: RGBA; n?: number }) => {
  const theme = useTheme().theme
  if (p.rows === null) return (
    <box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
      <box height={1}><text fg={theme.textMuted}>{p.title}</text></box>
      <box height={1}><Spinner label="aggregating…" /></box>
    </box>
  )
  const top = p.rows.slice(0, p.n ?? 10)
  const peak = Math.max(1, ...top.map(r => r.n))
  const total = p.rows.reduce((a, r) => a + r.n, 0)
  return (
    <box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
      <box height={1}><text fg={theme.textMuted}>{p.title}</text></box>
      {top.length === 0
        ? <box height={1}><text fg={theme.textMuted}>—</text></box>
        : top.map(r => (
            <box key={r.name} height={1} flexDirection="row">
              <Col w={18}>{trunc(r.name, 17)}</Col>
              <Col w={12} fg={p.fg}>{"▇".repeat(Math.max(1, Math.round(10 * r.n / peak)))}</Col>
              <Col w={7} right>{fmt(r.n)}</Col>
              <Col w={6} right fg={theme.textMuted}>
                {total ? `${Math.round(100 * r.n / total)}%` : ""}
              </Col>
            </box>
          ))}
    </box>
  )
})

export const Analytics = memo((props: { focused?: boolean; load?: AnalyticsQuery }) => {
  const theme = useTheme().theme
  const dialog = useDialog()
  const dims = useTerminalDimensions()
  const [days, setDays] = useState(7)
  const [tick, setTick] = useState(0)
  const { data, tools, error } = useAnalyticsData(days, tick, props.load)

  const keys = useKeys()
  useKeyboard((key) => {
    if (!props.focused || dialog.open()) return
    if (keys.match("list.refresh", key)) { cache.delete(days); return setTick(n => n + 1) }
    if (key.raw === "1") return setDays(1)
    if (key.raw === "7") return setDays(7)
    if (key.raw === "3") return setDays(30)
    if (key.raw === "9") return setDays(90)
  })

  const t = data?.total
  const tok = (t?.input ?? 0) + (t?.output ?? 0)
  const title = useMemo(() => !t
    ? `Analytics · ${days}d`
    : `Analytics · ${days}d · ${t.sessions} sess · ${fmt(tok)} tok · ${cost(t.cost)}`,
    [days, t, tok])

  const wide = dims.width >= 110
  const chartH = dims.height >= 40 ? 8 : 6

  if (!data) return (
    <box flexDirection="column" flexGrow={1} minWidth={0}>
      <TabShell title={title}>
        <box height={1}>{error
          ? <text fg={theme.error}>{error}</text>
          : <Spinner label={`aggregating ${days}d…`} />}</box>
      </TabShell>
      <HintBar pairs={[
        ["1/7/3/9", "period"],
        [keys.print("list.refresh"), "reload"],
      ]} />
    </box>
  )

  // Tools/Sources section height: header + n rows. Wide=side-by-side so
  // height = max(tools.n, sources.n)+1. Stacked = tools.n+sources.n+3 (two
  // headers + gap). Reserve this at the bottom so byModel scrollbox never
  // steals their space. n caps match the Rank defaults.
  const nTools = 8
  const nSrc = 6
  const ranksH = wide ? Math.max(nTools, nSrc) + 1 : nTools + nSrc + 3

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0}>
    <TabShell title={title}>
      <box flexDirection="column" flexGrow={1} minWidth={0} overflow="hidden">
        {error ? <box height={1}><text fg={theme.error}>{error}</text></box> : null}
        {/* Summary + chart — fixed block */}
        <box flexShrink={0} flexDirection="column">
          <box height={1}><text fg={theme.textMuted}>
            {`Cost per day  ·  ${fmt(t!.input)} in · ${fmt(t!.output)} out · ${fmt(t!.cache)} cache · ${fmt(t!.calls)} tool calls`}
          </text></box>
          <Chart data={data} h={chartH} />
        </box>

        {/* Model breakdown — grows to fill, but byModel can be empty/short */}
        <box height={1} flexShrink={0} />
        <box flexShrink={0}>
          <Hdr>
            <Col grow min={18} fg={theme.textMuted}>Model</Col>
            <Col w={6} right fg={theme.textMuted}>sess</Col>
            <Col w={9} right fg={theme.textMuted}>in</Col>
            <Col w={9} right fg={theme.textMuted}>out</Col>
            <Col w={9} right fg={theme.textMuted}>cache</Col>
            <Col w={9} right fg={theme.textMuted}>cost</Col>
          </Hdr>
        </box>
        <scrollbox scrollY flexGrow={1} flexShrink={1} minHeight={1}>
          <box flexDirection="column" width="100%">
            {data.byModel.length === 0
              ? <box height={1}><text fg={theme.textMuted}>no sessions in range</text></box>
              : data.byModel.map(m => (
                  <box key={m.model} height={1} flexDirection="row">
                    <Col grow min={18}>{trunc(m.model, 40)}</Col>
                    <Col w={6} right fg={theme.textMuted}>{String(m.sessions)}</Col>
                    <Col w={9} right>{fmt(m.input)}</Col>
                    <Col w={9} right>{fmt(m.output)}</Col>
                    <Col w={9} right fg={theme.textMuted}>{fmt(m.cache)}</Col>
                    <Col w={9} right fg={theme.accent}>{cost(m.cost)}</Col>
                  </box>
                ))}
          </box>
        </scrollbox>

        {/* Tools + Sources — fixed bottom, never overflows */}
        <box height={1} flexShrink={0} />
        <box flexShrink={0} height={ranksH}
             flexDirection={wide ? "row" : "column"} gap={wide ? 2 : 1}>
          <Rank title="Tools" rows={tools} fg={theme.success} n={nTools} />
          <Rank title="Sources" rows={data.bySource} fg={theme.info} n={nSrc} />
        </box>
      </box>
    </TabShell>
    <HintBar pairs={[
      ["1/7/3/9", "period"],
      [keys.print("list.refresh"), "reload"],
    ]} />
    </box>
  )
})
