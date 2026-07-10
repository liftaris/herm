import { useState, useEffect, useCallback, useRef, memo } from "react";
import { useKeyboard } from "@opentui/react";
import type { RGBA } from "@opentui/core";
import { useKeys, handleListKey, useFollow } from "../keys";
import type { Dispatch, SetStateAction } from "react";
import { makeSource, readSkillFrontmatter, listCuratorRuns, readCuratorReport, indexCuratorLineage, type SkillInfo, type SkillUsage, type CuratorRun, type LineageEvent } from "../service/hermes-home";
import { count as tokenCount } from "../utils/tokens";
import { useGateway } from "../context/gateway";
import { useDialog } from "../ui/dialog";
import { useToast } from "../ui/toast";
import { useTheme } from "../theme";
import { useHome } from "../home";
import { TabShell } from "../ui/shell";
import { HintBar } from "../ui/hint";
import { KVBlock } from "../ui/kv";
import { KVLink } from "../components/ui/FileLink";
import { Col, Hdr, Marquee, VBAR } from "../ui/table";
import { ago } from "../ui/fmt";
import { openConfirm } from "../dialogs/confirm";
import { openCurator } from "../dialogs/curator";

const NO_EVENTS: LineageEvent[] = []

type Hit = { name: string; description?: string }
type Sort = "name" | "used"

// ISO timestamp → epoch seconds (or null if unparseable/empty).
const iso = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

const SkillRow = memo((props: {
  id: string;
  skill: SkillInfo;
  usage?: SkillUsage;
  selected: boolean;
  onSelect: () => void;
  onHover: () => void;
}) => {
  const theme = useTheme().theme;
  const s = props.skill;
  const u = props.usage;
  const bg = props.selected ? theme.backgroundElement : undefined;
  const used = iso(u?.last_used_at) ?? iso(u?.last_viewed_at);
  const stale = u?.state === "stale";
  const archived = u?.state === "archived";

  return (
    <box id={props.id} flexDirection="row" height={1} backgroundColor={bg}
         onMouseDown={props.onSelect} onMouseMove={props.onHover}>
      <Col w={2} fg={props.selected ? theme.primary : theme.text}>{props.selected ? "▸ " : "  "}</Col>
      <Col w={2} fg={theme.warning}>{u?.pinned ? "📌" : "  "}</Col>
      <Marquee grow min={8} active={props.selected}
               fg={archived ? theme.textMuted : props.selected ? theme.accent : theme.text}>{s.name}</Marquee>
      {archived ? <Col w={10} fg={theme.textMuted}>archived</Col>
       : stale ? <Col w={10} fg={theme.warning}>stale</Col>
       : <Col w={10} fg={theme.textMuted}>{used ? ago(used) : ""}</Col>}
    </box>
  );
});

const HitRow = memo((props: { hit: Hit; selected: boolean; onHover: () => void }) => {
  const theme = useTheme().theme;
  const on = props.selected;
  return (
    <box flexDirection="row" height={1} backgroundColor={on ? theme.backgroundElement : undefined}
         onMouseMove={props.onHover}>
      <Col w={2} fg={on ? theme.primary : theme.textMuted}>{on ? "▸ " : "  "}</Col>
      <Col w={28} fg={on ? theme.accent : theme.text}>{props.hit.name}</Col>
      <Col grow min={8} fg={theme.textMuted}>{props.hit.description || "—"}</Col>
    </box>
  );
});

const bycat = (skills: SkillInfo[]) => skills.reduce((map, s) => {
  const cat = s.category || "uncategorized"
  map.set(cat, [...(map.get(cat) ?? []), s])
  return map
}, new Map<string, SkillInfo[]>())

const line = (e: LineageEvent): string => {
  switch (e.kind) {
    case "absorbed":   return `absorbed ${e.sources.map(s => `\`${s}\``).join(", ")}`
    case "merged":     return `merged into \`${e.into}\`${e.reason ? ` — ${e.reason}` : ""}`
    case "transition": return `${e.from} → ${e.to}`
    case "pruned":     return `pruned${e.reason ? ` — ${e.reason}` : ""}`
    case "added":      return "created by curator"
  }
}

const DetailPanel = memo((props: { skill: SkillInfo; usage?: SkillUsage; events: LineageEvent[] }) => {
  const theme = useTheme().theme;
  const s = props.skill;
  const u = props.usage;
  const used = iso(u?.last_used_at);
  const viewed = iso(u?.last_viewed_at);
  const patched = iso(u?.last_patched_at);

  return (
    <box
      flexDirection="column"
      padding={1}
      border
      borderColor={theme.border}
      backgroundColor={theme.backgroundPanel}
      width="50%"
    >
      <box height={1}>
        <text>
          <span fg={theme.primary}><strong>Skill Detail</strong></span>
          {u?.pinned ? <span fg={theme.warning}>  📌 pinned</span> : null}
          {u?.state === "stale" ? <span fg={theme.warning}>  · stale</span> : null}
          {u?.state === "archived" ? <span fg={theme.textMuted}>  · archived</span> : null}
        </text>
      </box>
      <box height={1} />
      <box height={1}><text fg={theme.accent}><strong>{s.name}</strong></text></box>
      <box height={1} />
      <KVBlock rows={([
        ["Category", s.category || "uncategorized", theme.info],
        ["Tags", s.tags.length > 0 ? s.tags.join(", ") : undefined],
        u ? ["Used", u.use_count > 0 ? `${u.use_count}× · last ${used ? ago(used) : "never"}` : "never"] : null,
        u && viewed ? ["Viewed", `${u.view_count}× · last ${ago(viewed)}`] : null,
        u && patched ? ["Patched", `${u.patch_count}× · last ${ago(patched)}`] : null,
      ]).filter(Boolean) as Array<[string, string | undefined, (RGBA | undefined)?]>} />
      <KVLink label="File" source={s.source} text={s.source.relative} />
      <box height={1} />
      {s.description ? (
        <text wrapMode="word"><span fg={theme.text}>{s.description}</span></text>
      ) : (
        <text fg={theme.textMuted}>No description</text>
      )}
      {props.events.length > 0 ? (
        <box flexDirection="column" marginTop={1}>
          <box height={1}><text fg={theme.textMuted}>Curator lineage</text></box>
          {props.events.map((e, i) => (
            <box key={i} flexDirection="row" minHeight={1}>
              <box width={10} flexShrink={0}>
                <text fg={theme.textMuted}>{ago(e.at)}</text>
              </box>
              <box flexGrow={1} minHeight={1}>
                <text wrapMode="word" fg={theme.text}>{line(e)}</text>
              </box>
            </box>
          ))}
        </box>
      ) : u ? (
        <box height={1} marginTop={1}>
          <text fg={theme.textMuted}>No curator events for this skill</text>
        </box>
      ) : null}
    </box>
  );
});

const EmptyState = memo((props: { searching: boolean }) => {
  const theme = useTheme().theme;
  return (
    <box flexGrow={1} padding={2}>
      <text>
        <span fg={theme.textMuted}>
          {props.searching
            ? "No matching skills on hub"
            : "No skills found in ~/.hermes/skills/"}
        </span>
      </text>
    </box>
  );
});
// Right-hand pane (swaps with DetailPanel on `h`). Browsable list of
// logs/curator/{id}/ runs with counts from run.json; Enter toggles
// REPORT.md rendered through <markdown>. Independent selection so the
// skills list stays on whatever row it was.

const HistoryPanel = memo((props: { focused: boolean }) => {
  const { theme, syntaxStyle } = useTheme();
  const dialog = useDialog();
  const keys = useKeys();
  const follow = useFollow("skills-history");
  const [runs, setRuns] = useState<CuratorRun[]>(() => listCuratorRuns());
  const [sel, setSel] = useState(0);
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const run = runs[sel];

  useEffect(() => {
    if (!open || !run) return;
    let live = true;
    readCuratorReport(run.id).then(t => { if (live) setBody(t) });
    return () => { live = false };
  }, [open, run?.id]);

  // Collapse the expanded body whenever selection moves. Wraps setSel so
  // handleListKey's ↑↓/PgUp/PgDn/Home/End all trigger it uniformly.
  const moveSel: Dispatch<SetStateAction<number>> = useCallback(v => {
    setOpen(false);
    setSel(v);
  }, []);

  useKeyboard(key => {
    if (!props.focused || dialog.open()) return;
    handleListKey(keys, key, {
      count: runs.length, setSel: moveSel, ...follow.opts,
      onActivate: () => setOpen(o => !o),
      onRefresh: () => setRuns(listCuratorRuns()),
    });
  });

  return (
    <box flexDirection="column" padding={1} border
         borderColor={props.focused ? theme.primary : theme.border}
         backgroundColor={theme.backgroundPanel} width="50%">
      <box height={1}>
        <text>
          <span fg={theme.primary}><strong>Curator History</strong></span>
          <span fg={theme.textMuted}>
            {`  ${runs.length} run${runs.length === 1 ? "" : "s"}${runs[0] ? ` · last ${ago(runs[0].at)}` : ""}`}
          </span>
        </text>
      </box>
      <box height={1}><text fg={theme.textMuted}>{`↑↓ select · Enter expand · ${keys.print("list.refresh")} reload · h close`}</text></box>
      <box height={1} />
      {runs.length === 0
        ? <text fg={theme.textMuted}>no runs in ~/.hermes/logs/curator/</text>
        : (
          <scrollbox ref={follow.ref} scrollY flexGrow={1}>
            <box flexDirection="column" width="100%">
              {runs.map((r, i) => {
                const on = i === sel;
                return (
                  <box key={r.id} id={follow.id(i)} flexDirection="column">
                    <box height={1} flexDirection="row"
                         backgroundColor={on ? theme.backgroundElement : undefined}
                         onMouseDown={() => { setSel(i); setOpen(o => i === sel ? !o : true) }}>
                      <Col w={2} fg={on ? theme.primary : theme.textMuted}>{on ? "▸ " : "  "}</Col>
                      <Col w={12} fg={on ? theme.accent : theme.text}>{ago(r.at)}</Col>
                      <Col grow fg={theme.textMuted}>
                        {`${r.before}→${r.after}  arch ${r.archived}  cons ${r.consolidated}${r.added ? `  +${r.added}` : ""}`}
                      </Col>
                    </box>
                    {on && open ? (
                      <box marginLeft={2} marginTop={1} marginBottom={1}>
                        <markdown content={body || "…"} fg={theme.markdownText} syntaxStyle={syntaxStyle} />
                      </box>
                    ) : null}
                  </box>
                );
              })}
            </box>
          </scrollbox>
        )}
    </box>
  );
});

export const Skills = memo((props: { focused?: boolean }) => {
  const theme = useTheme().theme;
  const gw = useGateway();
  const dialog = useDialog();
  const toast = useToast();
  const usage = useHome("skillUsage") ?? {};
  const curator = useHome("curatorState");
  // Built once per tab-open; rebuilt when .curator_state fires (a run
  // finished and wrote a fresh run.json).
  const lineage = useRef(indexCuratorLineage());
  useEffect(() => { lineage.current = indexCuratorLineage() }, [curator?.run_count]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [selected, setSelected] = useState(0);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [sort, setSort] = useState<Sort>("name");
  const [history, setHistory] = useState(false);
  const seq = useRef(0);
  const listSeq = useRef(0);

  const load = useCallback(() => {
    const id = ++listSeq.current;
    gw.request<{ skills: Record<string, string[]> }>("skills.manage", { action: "list" })
      .then(res => {
        if (listSeq.current !== id) return;
        const raw = res.skills ?? {};
        const rows: SkillInfo[] = Object.entries(raw).flatMap(([cat, names]) =>
          names.map(n => {
            const source = makeSource(`skills/${cat}/${n}/SKILL.md`, `${n}/SKILL.md`);
            // Gateway list returns names only; enrich from on-disk
            // frontmatter so Description/Tags aren't dead columns.
            const fm = readSkillFrontmatter(source);
            return {
              source, category: cat, name: n,
              description: fm.description, tags: fm.tags,
              tokenEstimate: tokenCount(`${n} ${fm.description}`),
            };
          })
        );
        rows.sort((a, b) => a.source.relative.localeCompare(b.source.relative));
        setSkills(rows);
      })
      .catch((err: Error) => {
        if (listSeq.current === id) toast.show({ variant: "error", message: err.message });
      });
  }, [gw, toast]);

  useEffect(() => {
    load();
    return () => { listSeq.current++; };
  }, [load]);

  // Hub search — debounced, drop stale responses via seq ref.
  useEffect(() => {
    const id = ++seq.current;
    if (!searching || !query.trim()) { setHits([]); return }
    const t = setTimeout(() => {
      gw.request<{ results: Hit[] }>("skills.manage", { action: "search", query })
        .then(r => {
          if (seq.current !== id) return;
          setHits(r.results ?? []);
          setSelected(0);
        })
        .catch((err: Error) => {
          if (seq.current !== id) return;
          setHits([]);
          toast.show({ variant: "error", message: err.message });
        });
    }, 150);
    return () => clearTimeout(t);
  }, [gw, toast, query, searching]);

  // Group installed skills by category. When sorted by "used", flatten
  // into a single "by-recency" group so the cross-category order is visible.
  const groups = sort === "used"
    ? new Map<string, SkillInfo[]>([
        ["by recency", [...skills].sort((a, b) => {
          const ta = iso(usage[a.name]?.last_used_at) ?? iso(usage[a.name]?.last_viewed_at) ?? 0;
          const tb = iso(usage[b.name]?.last_used_at) ?? iso(usage[b.name]?.last_viewed_at) ?? 0;
          return tb - ta;
        })],
      ])
    : bycat(skills);

  // Flat list for keyboard navigation
  const flat = [...groups].flatMap(([cat, items]) => [
    { type: "header" as const, category: cat },
    ...items.map(s => ({ type: "skill" as const, skill: s })),
  ]);

  const skillRows = flat.filter(r => r.type === "skill");
  const count = searching ? hits.length : skillRows.length;
  const current = !searching && skillRows[selected]?.type === "skill"
    ? skillRows[selected].skill : null;
  const follow = useFollow("sk");

  const exit = useCallback(() => {
    setSearching(false); setQuery(""); setHits([]); setSelected(0);
  }, []);

  const install = useCallback(async (name: string) => {
    const ok = await openConfirm(dialog, {
      title: "Install skill?",
      body: name,
      yes: "install",
    });
    if (!ok) return;
    gw.request("skills.manage", { action: "install", query: name })
      .then(() => {
        toast.show({ variant: "success", message: `Installed ${name}` });
        exit();
        load();
      })
      .catch((e: Error) =>
        toast.show({ variant: "error", message: `Install failed: ${e.message}` }));
  }, [dialog, gw, toast, exit, load]);

  const keys = useKeys();
  useKeyboard((key) => {
    if (!props.focused || dialog.open()) return;

    if (searching) {
      if (key.name === "escape") { exit(); return }
      if (key.name === "backspace") { setQuery(p => p.slice(0, -1)); setSelected(0); return }
      if (key.name === "up") return setSelected(p => Math.max(0, p - 1));
      if (key.name === "down") return setSelected(p => Math.min(count - 1, p + 1));
      if (key.name === "return") {
        const hit = hits[selected];
        if (hit) install(hit.name);
        return;
      }
      if (key.raw && key.raw.length === 1 && key.raw >= " ") {
        setQuery(p => p + key.raw); setSelected(0);
      }
      return;
    }

    // `s` toggles sort between category/name (default) and recency.
    // Intercept before handleListKey so the stock list vocabulary stays intact.
    if (!key.ctrl && !key.meta && key.raw === "s") {
      setSort(p => p === "name" ? "used" : "name");
      setSelected(0);
      return;
    }

    // `c` opens the Curator report dialog.
    if (!key.ctrl && !key.meta && key.raw === "c") {
      openCurator(dialog);
      return;
    }

    // `h` toggles the curator run-history pane in place of DetailPanel.
    // When open it owns ↑↓/Enter/r; Esc or `h` returns here.
    if (!key.ctrl && !key.meta && key.raw === "h") {
      setHistory(h => !h);
      return;
    }
    if (history) {
      if (key.name === "escape") return setHistory(false);
      return;   // HistoryPanel's own useKeyboard handles the rest
    }

    handleListKey(keys, key, {
      count, setSel: setSelected, ...follow.opts,
      onRefresh: () => { load(); toast.show({ variant: "info", message: "Reloaded", duration: 1000 }) },
      onSearch: () => { setSearching(true); setQuery(""); setHits([]); setSelected(0) },
    });
  });

  // Track which skill index we're on as we iterate through the grouped list
  let skillIdx = -1;

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0}>
    <box flexDirection="row" flexGrow={1}>
      <TabShell
        title={searching ? `Hub Search (${hits.length})` : `Skills (${skills.length}${sort === "used" ? " · by use" : ""})`}
      >
        {/* Search bar */}
        {searching ? (
          <box height={1}>
            <text>
              <span fg={theme.accent}>{"/ "}</span>
              <span fg={theme.text}>{query}</span>
              <span fg={theme.accent}>{"█"}</span>
            </text>
          </box>
        ) : null}

        {searching ? null : (
          <Hdr>
            <Col w={2} fg={theme.textMuted}>{""}</Col>
            <Col grow min={8} fg={theme.textMuted} bold>Name</Col>
          </Hdr>
        )}
        {searching ? null : <box height={1} />}

        {/* List */}
        {count === 0 ? (
          <EmptyState searching={searching} />
        ) : searching ? (
          <scrollbox scrollY flexGrow={1}>
            <box flexDirection="column" width="100%">
              {hits.map((h, i) => (
                <HitRow key={h.name} hit={h} selected={i === selected}
                  onHover={() => setSelected(i)} />
              ))}
            </box>
          </scrollbox>
        ) : (
          <scrollbox ref={follow.ref} scrollY flexGrow={1} verticalScrollbarOptions={VBAR}>
            {flat.map((row, i) => {
              if (row.type === "header") {
                return (
                  <box key={`h-${row.category}`} marginTop={i > 0 ? 1 : 0}>
                    <text fg={theme.info}><strong>{`▾ ${row.category}`}</strong></text>
                  </box>
                );
              }
              skillIdx++;
              const idx = skillIdx;
              return (
                <SkillRow
                  key={row.skill.name}
                  id={follow.id(idx)}
                  skill={row.skill}
                  usage={usage[row.skill.name]}
                  selected={idx === selected}
                  onSelect={() => setSelected(idx)}
                  onHover={() => setSelected(idx)}
                />
              );
            })}
          </scrollbox>
        )}

        {/* Curator footer — summary of last run / paused state. Driven by
            fs.watch on ~/.hermes/skills/.curator_state; silent when absent. */}
        {!searching && curator ? (
          <box height={1} flexShrink={0}>
            <text>
              <span fg={theme.textMuted}>{"curator · "}</span>
              {curator.paused ? (
                <span fg={theme.warning}>paused</span>
              ) : curator.last_run_at ? (
                <span fg={theme.textMuted}>
                  {`${curator.run_count} run${curator.run_count === 1 ? "" : "s"} · last ${ago(iso(curator.last_run_at) ?? 0)}`}
                </span>
              ) : (
                <span fg={theme.textMuted}>never run</span>
              )}
            </text>
          </box>
        ) : null}
      </TabShell>

      {/* Right-hand pane: curator history when toggled, else skill detail */}
      {history
        ? <HistoryPanel focused={!!props.focused && !searching} />
        : current ? <DetailPanel skill={current} usage={usage[current.name]}
                                  events={lineage.current.get(current.name) ?? NO_EVENTS} /> : null}
    </box>
    <HintBar pairs={searching
      ? [
          ["↑↓", "navigate"],
          ["Enter", "install"],
          ["Esc", "cancel"],
        ]
      : [
          ["↑↓", "navigate"],
          [keys.print("list.search"), "search hub"],
          ["s", "sort"],
          ["c", "curator"],
          ["h", "history"],
          [keys.print("list.refresh"), "refresh"],
        ]} />
    </box>
  );
});
