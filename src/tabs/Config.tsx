import { useState, useEffect, useCallback, useRef, memo, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { useKeys, handleListKey, useFollow } from "../keys";
import { useGateway, useGatewayRestart } from "../context/gateway";
import { useTheme } from "../theme";
import { useToast } from "../ui/toast";
import { useDialog } from "../ui/dialog";
import { openConfirm } from "../dialogs/confirm";
import { TabShell } from "../ui/shell";
import { HintBar } from "../ui/hint";
import { Col, Hdr, VBAR } from "../ui/table";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { writeConfig, verifyWrite, maxEffect } from "../config/lane";
import { check as checkRule } from "../config/rules";
import { buildFields, groupOf, sections, GROUPS, EFFECT_GLYPH, type Field, type Section } from "../config";
import { readSlots, assign, resetAux, AUX_TASKS, staleAuxForMain, type Slot } from "../config/models";
import { openModelPicker } from "../dialogs/model-picker";
import { managedSystem, makeSource } from "../service/hermes-home";
import { FileLink } from "../components/ui/FileLink";

const flatten = (obj: Record<string, unknown>, prefix = ""): [string, unknown][] =>
  Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v))
      return flatten(v as Record<string, unknown>, key);
    return [[key, v]];
  });

const setNested = (obj: Record<string, unknown>, path: string, val: unknown) => {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== "object")
      cur[parts[i]] = {};
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = val;
};

const getNested = (obj: Record<string, unknown>, path: string): unknown => {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && !Array.isArray(cur))
      cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return cur;
};

const FieldRow = memo((props: {
  id: string;
  field: Field;
  active: boolean;
  changed: boolean;
  editing: boolean;
  buf: string;
  readonly?: boolean;
  error?: string;
  /** Search mode: resolved category shown as a pill so hits stay attributable. */
  badge?: string;
}) => {
  const theme = useTheme().theme;
  const f = props.field;
  const bg = props.active ? theme.backgroundElement : undefined;
  const indicator = props.active ? "▸ " : "  ";
  const mark = props.changed ? "● " : f.set ? "·" : " ";
  const markFg = props.changed ? theme.warning : theme.textMuted;

  const display = (): string => {
    if (props.editing) return props.buf + "█";
    if (f.type === "readonly") {
      const n = Array.isArray(f.value) ? f.value.length
        : f.value && typeof f.value === "object" ? Object.keys(f.value).length
        : 0;
      return n === 0 ? "—" : `${n} item${n === 1 ? "" : "s"}`;
    }
    if (f.type === "boolean") return f.value ? "✓ ON" : "✗ OFF";
    return String(f.value ?? "");
  };

  const hint = (): string => {
    if (props.readonly || f.type === "readonly") return "🔒";
    if (f.type === "boolean") return "[space]";
    if (f.type === "select") return "[h/l]";
    return "[enter]";
  };

  const ro = props.readonly || f.type === "readonly";
  const valFg = ro || !f.set ? theme.textMuted
    : f.type === "boolean" ? (f.value ? theme.success : theme.error)
    : theme.text;
  const labelFg = ro ? theme.textMuted : props.active ? theme.accent : theme.text;

  const lead = 4 + (props.badge !== undefined ? 12 : 0);
  const glyph = props.active ? EFFECT_GLYPH[f.effect] : "";

  return (
    <box id={props.id} flexDirection="column" backgroundColor={bg}>
      <box flexDirection="row" height={1}>
        <Col w={2} fg={markFg}>{mark}</Col>
        <Col w={2} fg={props.active ? theme.primary : theme.text}>{indicator}</Col>
        {props.badge !== undefined
          ? <Col w={12} fg={theme.textMuted}>{props.badge}</Col>
          : null}
        <Col w={40} fg={labelFg}>{f.label}</Col>
        <Col grow min={6} fg={valFg}>{display()}</Col>
        <Col w={2} fg={theme.textMuted}>{glyph}</Col>
        <Col w={9} fg={theme.textMuted} right>{props.active ? hint() : ""}</Col>
      </box>
      {props.error ? (
        <box flexDirection="row" height={1}>
          <Col w={lead + 40} fg={theme.textMuted}>{""}</Col>
          <Col grow min={6} fg={theme.error}>{`✗ ${props.error}`}</Col>
        </box>
      ) : props.active && f.doc ? (
        <box flexDirection="row" minHeight={1}>
          <box width={lead} flexShrink={0} />
          <box width={40} flexShrink={0} minHeight={1}>
            <text wrapMode="word" fg={theme.textMuted}>{f.doc}</text>
          </box>
        </box>
      ) : null}
    </box>
  );
});
// Main + 9 aux-task slots from config.yaml. Enter opens the same
// provider→model picker as Ctrl+M but routed through assign(); `x`
// resets an aux slot to auto. Writes apply immediately (not queued
// through the FieldRow dirty/save flow) because main is an rpc-lane
// hot-swap and aux is a 2-key atomic pair — both mirror webui
// ModelSettingsPanel which also commits on pick.

const SlotRow = memo((p: { id: string; s: Slot; on: boolean }) => {
  const theme = useTheme().theme;
  const main = p.s.kind === "main";
  const val = main
    ? `${p.s.provider || "(unset)"} · ${p.s.model || "(unset)"}`
    : p.s.auto
      ? "auto  (use main model)"
      : `${p.s.provider} · ${p.s.model || "(provider default)"}`;
  return (
    <box id={p.id} flexDirection="row" height={1}
         backgroundColor={p.on ? theme.backgroundElement : undefined}>
      <Col w={2} fg={p.on ? theme.primary : theme.text}>{p.on ? "▸ " : "  "}</Col>
      <Col w={2} fg={main ? theme.primary : theme.textMuted}>{main ? "★" : " "}</Col>
      <Col w={16} fg={p.on ? theme.accent : theme.text}>{p.s.label}</Col>
      <Col w={22} fg={theme.textMuted}>{p.s.hint}</Col>
      <Col grow min={10} fg={p.s.auto ? theme.textMuted : theme.text}>{val}</Col>
      <Col w={14} fg={theme.textMuted} right>
        {p.on ? (main ? "[enter]" : "[enter] [x]") : ""}
      </Col>
    </box>
  );
});

export const Config = memo((props: { focused?: boolean }) => {
  const theme = useTheme().theme;
  const gw = useGateway();
  const restartGateway = useGatewayRestart();
  const toast = useToast();
  const dialog = useDialog();
  const [raw, setRaw] = useState<Record<string, unknown>>({});
  const rawRef = useRef(raw);
  rawRef.current = raw;
  const [original, setOriginal] = useState<Record<string, unknown>>({});
  const [yaml, setYaml] = useState("");
  const [mode, setMode] = useState<"form" | "yaml">("form");
  const [cat, setCat] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const [buf, setBuf] = useState("");
  const [err, setErr] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<"categories" | "fields">("categories");
  const [managed, setManaged] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const loads = useRef(0);

  useEffect(() => { managedSystem().then(setManaged) }, []);

  const load = useCallback(() => {
    const gen = ++loads.current;
    gw.request<{ config?: Record<string, unknown> }>("config.get", { key: "full" })
      .then(res => {
        if (loads.current !== gen) return;
        const parsed = res.config ?? {};
        rawRef.current = structuredClone(parsed);
        setRaw(rawRef.current);
        setOriginal(structuredClone(parsed));
        setYaml(yamlStringify(parsed));
        setErr({});
        setLoadErr(null);
      })
      .catch(e => {
        if (loads.current === gen) setLoadErr(e instanceof Error ? e.message : String(e));
      });
  }, [gw]);

  useEffect(() => {
    load();
    return () => { loads.current++; };
  }, [load]);

  const all = buildFields(raw);
  const grouped = all.reduce((map, f) => {
    const g = groupOf(f.key);
    if (!map.has(g)) map.set(g, []);
    map.get(g)!.push(f);
    return map;
  }, new Map<string, Field[]>(GROUPS.map(g => [g, []])));
  // `models` is a synthetic category — it renders SlotRows over the
  // same `raw` object, not FieldRows over schema keys. Pinned after
  // `general` so it's where a user scanning for "where do I set the
  // model" lands, instead of the 56-field `auxiliary` group.
  const groups = [...grouped.keys()];
  groups.splice(1, 0, "models");

  const active = groups[cat] ?? groups[0];
  const onSlots = active === "models" && !searching;
  const slots = readSlots(raw);
  const secs: Section[] = searching && query.trim()
    ? [{ head: null, items: all.filter(f => f.key.toLowerCase().includes(query.toLowerCase())) }]
    : sections(active, grouped.get(active) ?? []);
  const fields = secs.flatMap(s => s.items);

  const count = onSlots ? slots.length : fields.length;
  const follow = useFollow("cfg");
  const catFollow = useFollow("cfg-cat");

  const changed = (key: string): boolean =>
    JSON.stringify(getNested(raw, key)) !== JSON.stringify(getNested(original, key));

  const nChanged = all.reduce((n, f) => n + (changed(f.key) ? 1 : 0), 0);

  const update = (key: string, val: unknown) => {
    loads.current++;
    const next = structuredClone(rawRef.current);
    setNested(next, key, val);
    rawRef.current = next;
    setRaw(next);
    setYaml(yamlStringify(next));
  };

  const fmt = (v: unknown) =>
    v === undefined ? "—" : Array.isArray(v) ? v.join(", ") : String(v);

  const save = async () => {
    if (managed) {
      toast.show({ variant: "error", message: `Managed by ${managed} — edit configuration.nix` });
      return;
    }
    const nErr = Object.keys(err).length;
    if (nErr > 0) {
      toast.show({ variant: "error", message: `${nErr} invalid field${nErr === 1 ? "" : "s"}` });
      return;
    }
    const target = mode === "yaml" ? (yamlParse(yaml) ?? {}) : rawRef.current;
    const flat = flatten(target as Record<string, unknown>);
    const diffs = flat
      .filter(([key]) => JSON.stringify(getNested(target as Record<string, unknown>, key)) !== JSON.stringify(getNested(original, key)))
      .map(([key, val]) => ({ key, from: getNested(original, key), to: val }));
    if (diffs.length === 0) {
      toast.show({ variant: "info", message: "No changes" });
      return;
    }
    const body = diffs.map(d => `${d.key}: ${fmt(d.from)} → ${fmt(d.to)}`).join("\n");
    const ok = await openConfirm(dialog, {
      title: `Write ${diffs.length} change${diffs.length === 1 ? "" : "s"} to config.yaml?`,
      body, yes: "save",
    });
    if (!ok) return;
    const res = await writeConfig(gw, diffs.map(d => ({ key: d.key, to: d.to })));
    for (const w of res.warnings) toast.show({ variant: "info", message: `${w.key}: ${w.msg}` });
    if (res.failed.length > 0) {
      load();
      toast.show({
        variant: "error",
        message: `${res.failed.length} failed: ${res.failed.map(f => f.key).join(", ")}`,
      });
      return;
    }
    const landed = diffs.filter(d => res.ok.includes(d.key));
    const miss = await verifyWrite(gw, landed.map(d => ({ key: d.key, to: d.to })))
      .catch(e => {
        toast.show({ variant: "error", message: e instanceof Error ? e.message : String(e) });
        return null;
      });
    if (!miss) return;
    if (miss.length > 0) {
      toast.show({ variant: "error", message: `Write didn't land: ${miss.join(", ")}` });
      return;
    }
    load();
    const tier = maxEffect(res.ok);
    if (tier === "restart") {
      const go = await openConfirm(dialog, {
        title: `Saved — ${res.ok.length} setting${res.ok.length === 1 ? "" : "s"} need a gateway restart`,
        body: "Restart now? This interrupts any running turn.",
        yes: "restart now", no: "later", danger: true,
      });
      if (go) {
        restartGateway("resume");
        toast.show({ variant: "info", message: "Gateway restarting…" });
      }
      return;
    }
    toast.show({
      variant: "success",
      message: tier === "live" ? "Saved" : "Saved — new sessions pick this up",
    });
  };

  const pick = useCallback((s: Slot) => {
    if (managed) return toast.show({ variant: "error", message: `Managed by ${managed}` });
    const warnStaleAux = async (prov: string) => {
      const stale = staleAuxForMain(readSlots(raw), prov);
      if (stale.length === 0) return;
      const names = stale.map(x => x.label).join(", ");
      const ok = await openConfirm(dialog, {
        title: "Auxiliary models still pinned to another provider",
        body: `${names}\n\nReset these slots to auto so they follow the main model?`,
        yes: "reset stale", no: "keep",
      });
      if (!ok) {
        toast.show({ variant: "warning", message: `Aux still pinned to another provider: ${names}. Press X to reset all to auto.` });
        return;
      }
      for (const slot of stale) {
        const r = await resetAux(gw, slot.key);
        if (r.failed.length) {
          toast.show({ variant: "error", message: `${slot.label}: ${r.failed.map(f => f.err).join("; ")}` });
          return;
        }
      }
      toast.show({ variant: "success", message: `Reset ${stale.length} aux slot${stale.length === 1 ? "" : "s"} → auto` });
      load();
    };
    openModelPicker(dialog, gw, {
      title: s.kind === "main" ? "Set main model" : `Set auxiliary · ${s.label}`,
      onApply: async (prov, model) => {
        const token = dialog.version();
        const r = await assign(gw, s.key, prov, model);
        if (r.failed.length)
          return toast.show({ variant: "error", message: r.failed.map(f => f.err).join("; ") });
        toast.show({ variant: "success",
          message: s.kind === "main" ? `main → ${prov} · ${model}` : `${s.key} → ${prov} · ${model}` });
        if (r.warning) toast.show({ variant: "warning", message: r.warning });
        load();
        if (s.kind === "main" && dialog.version() === token) await warnStaleAux(prov);
      },
    });
  }, [gw, dialog, toast, load, managed, raw]);

  const unset = useCallback((s: Slot) => {
    if (managed || s.kind !== "aux" || s.auto) return;
    void resetAux(gw, s.key).then(r => {
      if (r.failed.length)
        return toast.show({ variant: "error", message: r.failed.map(f => f.err).join("; ") });
      toast.show({ variant: "success", message: `${s.key} → auto` });
      load();
    });
  }, [gw, toast, load, managed]);

  const unsetAll = useCallback(() =>
    openConfirm(dialog, {
      title: "Reset all auxiliary slots to auto?",
      body: `${AUX_TASKS.length} slots. Each falls back to the main model.`,
      yes: "reset", danger: true,
    }).then(ok => {
      if (!ok) return;
      void resetAux(gw, "all").then(r => {
        if (r.failed.length)
          return toast.show({ variant: "error", message: `${r.failed.length} failed` });
        toast.show({ variant: "success", message: "All auxiliary slots → auto" });
        load();
      });
    }), [gw, dialog, toast, load]);

  const keys = useKeys();
  useKeyboard((key) => {
    if (!props.focused || dialog.open()) return;
    if (keys.match("config.mode", key) && !editing && !searching) {
      setMode(m => m === "form" ? "yaml" : "form");
      return;
    }

    if (keys.match("config.save", key)) return void save();

    if (mode === "yaml") {
      if (key.name === "backspace") { loads.current++; setYaml(prev => prev.slice(0, -1)); return; }
      if (key.name === "return") { loads.current++; setYaml(prev => prev + "\n"); return; }
      if (key.raw && key.raw.length === 1 && key.raw >= " ") {
        loads.current++;
        setYaml(prev => prev + key.raw);
        return;
      }
      return;
    }

    if (searching) {
      if (key.name === "escape") { setSearching(false); setQuery(""); setCursor(0); return; }
      if (key.name === "backspace") { setQuery(prev => prev.slice(0, -1)); setCursor(0); return; }
      if (key.name === "up") { setCursor(c => Math.max(0, c - 1)); return; }
      if (key.name === "down") { setCursor(c => Math.min(count - 1, c + 1)); return; }
      if (key.raw && key.raw.length === 1 && key.raw >= " ") {
        setQuery(prev => prev + key.raw);
        setCursor(0);
        return;
      }
      return;
    }

    if (editing) {
      const f = fields[cursor];
      if (key.name === "escape") {
        setEditing(false); setBuf("");
        if (f) setErr(e => { const { [f.key]: _, ...rest } = e; return rest });
        return;
      }
      if (key.name === "return") {
        if (f) {
          const msg = checkRule(f.key, buf);
          if (msg) { setErr(e => ({ ...e, [f.key]: msg })); return; }
          setErr(e => { const { [f.key]: _, ...rest } = e; return rest });
          const val = f.type === "number" ? Number(buf) || 0 : buf;
          update(f.key, val);
        }
        setEditing(false);
        setBuf("");
        return;
      }
      if (key.name === "backspace") { setBuf(prev => prev.slice(0, -1)); return; }
      if (key.raw && key.raw.length === 1) { setBuf(prev => prev + key.raw); return; }
      return;
    }

    if (key.name === "tab") {
      setFocus(f => f === "categories" ? "fields" : "categories");
      return;
    }
    if (keys.match("list.search", key)) { setSearching(true); setQuery(""); setCursor(0); return; }

    if (focus === "categories") {
      if (key.name === "up") {
        setCat(c => { const n = Math.max(0, c - 1); catFollow.opts.scrollTo(n); return n });
        setCursor(0);
        return;
      }
      if (key.name === "down") {
        setCat(c => { const n = Math.min(groups.length - 1, c + 1); catFollow.opts.scrollTo(n); return n });
        setCursor(0);
        return;
      }
      if (key.name === "return") { setFocus("fields"); return; }
      return;
    }

    if (onSlots) {
      const s = slots[cursor];
      const matched = handleListKey(keys, key, {
        count, setSel: setCursor, ...follow.opts,
        onActivate: s ? () => pick(s) : undefined,
        onRefresh: () => { load(); toast.show({ variant: "info", message: "Reloaded", duration: 1000 }) },
      });
      if (matched || !s) return;
      if (key.raw === "x") return unset(s);
      if (key.raw === "X") return void unsetAll();
      return;
    }

    const f = fields[cursor];
    const writable = !managed;
    const matched = handleListKey(keys, key, {
      count, setSel: setCursor, ...follow.opts,
      onRefresh: () => { load(); toast.show({ variant: "info", message: "Reloaded", duration: 1000 }) },
      onToggle: writable && f?.type === "boolean" ? () => {
        const value = getNested(rawRef.current, f.key);
        update(f.key, !(value === undefined ? f.value : value));
      } : undefined,
      onActivate: f && writable && (f.type === "string" || f.type === "number")
        ? () => { setEditing(true); setBuf(String(f.value ?? "")) }
        : undefined,
    });
    if (matched || !f || !writable) return;

    if (f.type === "select" && f.options) {
      const value = getNested(rawRef.current, f.key);
      const idx = f.options.indexOf(String(value === undefined ? f.value : value));
      if (key.raw === "l" || key.raw === "]") {
        update(f.key, f.options[(idx + 1) % f.options.length]);
        return;
      }
      if (key.raw === "h" || key.raw === "[") {
        update(f.key, f.options[(idx - 1 + f.options.length) % f.options.length]);
        return;
      }
    }
  });

  if (mode === "yaml") {
    return (
      <box flexDirection="column" flexGrow={1} minWidth={0}>
      <TabShell title="Config · YAML" error={loadErr}>
        <scrollbox scrollY flexGrow={1}>
          <text wrapMode="word">
            <span fg={theme.text}>{yaml}</span>
            <span fg={theme.accent}>█</span>
          </text>
        </scrollbox>
      </TabShell>
      <HintBar pairs={[
        [keys.print("config.mode"), "form"],
        [keys.print("config.save"), "save"],
      ]} />
      </box>
    );
  }

  // Search collapses to single-pane: input row sits above (outside)
  // both shells so placement matches scope (all categories). Results
  // rows carry a category badge so hits stay attributable; Esc
  // restores two-pane.
  return (
    <box flexDirection="column" flexGrow={1}>
      {searching ? (
        <box height={1} paddingLeft={1} paddingRight={1}>
          <text>
            <span fg={theme.accent}>┃ </span>
            <span fg={theme.text}>{query}</span>
            <span fg={theme.accent}>█</span>
            <span fg={theme.textMuted}>{`   ${count} of ${all.length}  ·  ↑↓ nav  ·  Esc close`}</span>
          </text>
        </box>
      ) : null}
      <box flexDirection="row" flexGrow={1}>
        {searching ? null : (
          <TabShell title="Config" grow={1}
                    focus={focus === "categories"}>
            <scrollbox ref={catFollow.ref} scrollY flexGrow={1}>
              {groups.map((c, i) => {
                const sel = i === cat;
                const hot = sel && focus === "categories";
                const items = grouped.get(c) ?? [];
                const n = c === "models" ? slots.length : items.length;
                const catDirty = items.some(f => changed(f.key));
                return (
                  <box
                    key={c}
                    id={catFollow.id(i)}
                    backgroundColor={hot ? theme.backgroundElement : undefined}
                    onMouseDown={() => { setCat(i); setCursor(0); setFocus("categories"); }}
                  >
                    <text>
                      <span fg={catDirty ? theme.warning : theme.textMuted}>{catDirty ? "●" : " "}</span>
                      <span fg={hot ? theme.accent : sel ? theme.primary : theme.text}>
                        {sel ? "▸ " : "  "}{c}
                      </span>
                      <span fg={theme.textMuted}>{` (${n})`}</span>
                    </text>
                  </box>
                );
              })}
            </scrollbox>
          </TabShell>
        )}

        <TabShell
          title={onSlots ? "models · applies immediately"
            : searching ? "Search" : nChanged > 0 ? `${active} · ${nChanged} unsaved` : active}
          grow={3} focus={focus === "fields" || searching} error={loadErr}
        >
          {managed ? (
            <box height={1} flexDirection="row" gap={1}>
              <text fg={theme.warning}>🔒 managed install — edit</text>
              <FileLink source={makeSource("config.yaml")}>config.yaml</FileLink>
              <text fg={theme.warning}>via configuration.nix</text>
            </box>
          ) : null}
          {onSlots ? (
            <box key="slots" flexDirection="column" flexGrow={1}>
              <box height={1}><text fg={theme.textMuted}>
                Auxiliary tasks handle side-jobs. 'auto' = use main model. Per-task api_key/base_url/timeout live in the 'auxiliary' category.
              </text></box>
              <box height={1} />
              <scrollbox ref={follow.ref} scrollY flexGrow={1} verticalScrollbarOptions={VBAR}>
                {slots.map((s, i) => (
                  <SlotRow key={s.key} id={follow.id(i)} s={s}
                           on={i === cursor && focus === "fields"} />
                ))}
              </scrollbox>
            </box>
          ) : (<>
          <Hdr>
            <Col w={4} fg={theme.textMuted}>{""}</Col>
            {searching ? <Col w={12} fg={theme.textMuted} bold>Category</Col> : null}
            <Col w={40} fg={theme.textMuted} bold>Field</Col>
            <Col grow min={6} fg={theme.textMuted} bold>Value</Col>
            <Col w={2} fg={theme.textMuted}>{""}</Col>
            <Col w={9} fg={theme.textMuted}>{""}</Col>
          </Hdr>
          <box height={1} />

          {count === 0 ? (
            <box key="empty" flexGrow={1} padding={2}>
              <text fg={theme.textMuted}>
                {searching ? "No matching fields" : "No fields in this category"}
              </text>
            </box>
          ) : (
            <scrollbox ref={follow.ref} key="list" scrollY flexGrow={1}
                       verticalScrollbarOptions={VBAR}>
              {secs.reduce<{ base: number; out: ReactNode[] }>((acc, s) => {
                if (s.head !== null) acc.out.push(
                  <box key={`§${s.head}`} height={1} marginTop={acc.base > 0 ? 1 : 0}>
                    <text fg={theme.textMuted}>─ {s.head} </text>
                  </box>
                );
                s.items.forEach((f, j) => {
                  const i = acc.base + j;
                  acc.out.push(
                    <FieldRow
                      key={f.key}
                      id={follow.id(i)}
                      field={f}
                      active={i === cursor && (focus === "fields" || searching)}
                      changed={changed(f.key)}
                      editing={editing && i === cursor}
                      buf={buf}
                      readonly={!!managed}
                      error={err[f.key]}
                      badge={searching ? groupOf(f.key) : undefined}
                    />
                  );
                });
                acc.base += s.items.length;
                return acc;
              }, { base: 0, out: [] }).out}
            </scrollbox>
          )}
          </>)}
        </TabShell>
      </box>
      {managed
        ? <HintBar raw={`read-only · managed by ${managed}`} />
        : onSlots
          ? <HintBar pairs={[
              ["↑↓", "nav"],
              ["Enter", "pick"],
              ["x", "reset"],
              ["X", "reset-all"],
              ["Tab", "categories"],
            ]} />
          : focus === "categories" && !searching
            ? <HintBar pairs={[["↑↓", "select"], ["Tab", "fields"]]} />
            : <HintBar
                pairs={[
                  [keys.print("config.mode"), "yaml"],
                  ["Tab", "categories"],
                  ["↑↓", "nav"],
                  [keys.print("list.search"), "search"],
                  [keys.print("config.save"), "save"],
                ]}
                suffix={nChanged > 0 ? `● ${nChanged} unsaved` : undefined}
              />}
    </box>
  );
});
