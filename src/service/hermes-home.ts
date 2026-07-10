/**
 * hermes-home.ts — Reader for the ~/.hermes/ directory.
 *
 * This is herm's window into the Hermes Agent's persistent state.
 * All reads are filesystem-based (Bun APIs), no HTTP needed.
 *
 * Every piece of extracted data carries a `source: Source` field so the
 * UI can generically render clickable file links without knowing paths.
 */

import { Database } from "bun:sqlite";
import { readdir, stat } from "node:fs/promises";
import { openSync, readSync, closeSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";
import { count as tokenCount } from "../utils/tokens";
//
// Mutable cell — profile switch (herm-q73) rebinds this at runtime so
// every hermesPath() caller follows without a process restart. Same
// shape as sessions-db.ts:setHome; orchestration lives in home/rehome.

const HOME = process.env.HOME || homedir();
const home = { path: process.env.HERMES_HOME || `${HOME}/.hermes` };

/** Point all ~/.hermes readers at a new HERMES_HOME. */
export const setHome = (h: string): void => { home.path = h };

/** Resolve a path relative to ~/.hermes/ */
export const hermesPath = (relative: string): string =>
  `${home.path}/${relative}`;

/** Detect a package-manager-owned install. Two signals, matching
 *  hermes_cli/config.py:get_managed_system — HERMES_MANAGED env var
 *  (systemd service sets it) or the `.managed` marker file (NixOS
 *  activation script touches it so interactive shells see it too). */
export const managedSystem = async (): Promise<string | null> => {
  const env = (process.env.HERMES_MANAGED ?? "").trim()
  if (env) {
    const norm = env.toLowerCase()
    if (norm === "1" || norm === "true" || norm === "yes" || norm === "on") return "NixOS"
    const names: Record<string, string> = { homebrew: "Homebrew", nix: "NixOS", nixos: "NixOS" }
    return names[norm] ?? env
  }
  return (await Bun.file(hermesPath(".managed")).exists()) ? "NixOS" : null
}

/** Every piece of data extracted from ~/.hermes/ carries its origin file. */
export interface Source {
  file: string; // absolute path
  relative: string; // relative to HERMES_HOME
  label: string; // human-friendly display name
}

/** Build a Source for a file relative to HERMES_HOME */
export const makeSource = (
  relative: string,
  label?: string,
): Source => ({
  file: hermesPath(relative),
  relative,
  label: label ?? relative.split("/").pop() ?? relative,
});

/** Subset of config.yaml we care about */
export interface HermesConfig {
  source: Source;
  model: {
    default: string;
    provider: string;
    base_url: string;
    context_length?: number;
  };
  agent: {
    max_turns: number;
    reasoning_effort: string;
  };
  compression: {
    enabled: boolean;
    threshold: number;
    target_ratio: number;
    protect_last_n: number;
    summary_model: string;
  };
  memory: {
    memory_enabled: boolean;
    user_profile_enabled: boolean;
    memory_char_limit: number;
    user_char_limit: number;
    provider: string;
    nudge_interval: number;
    flush_min_turns: number;
  };
  display: {
    personality: string;
    skin: string;
    show_cost: boolean;
  };
  curator: {
    enabled: boolean;
    interval_hours: number;
    stale_after_days: number;
    archive_after_days: number;
  };
  approvals: {
    destructive_slash_confirm: boolean;
  };
  gateway: {
    platforms: {
      api_server?: {
        enabled: boolean;
        host: string;
        port: number;
      };
    };
  };
}

/** Memory file stats */
export interface MemoryFileInfo {
  source: Source;
  content: string;
  charCount: number;
  charLimit: number;
  usagePercent: number;
  entryCount: number;
}

/** A row from the sessions table in state.db — see sessions-db.ts. */
export type { SessionRow } from "./sessions-db"

/** Legacy live session entry from optional sessions/sessions.json. */
export interface LiveSession {
  session_key: string;
  session_id: string;
  created_at: string;
  updated_at: string;
  display_name: string;
  platform: string;
  chat_type: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  last_prompt_tokens: number;
  estimated_cost_usd: number;
  cost_status: string;
  memory_flushed: boolean;
  origin?: {
    platform: string;
    chat_id: string;
    chat_name: string;
    user_id: string;
    user_name: string;
  };
}

/** A tool schema from live session.info or a legacy debug session JSON. */
export interface ToolInfo {
  name: string;
  descriptionLength: number;
  paramsLength: number;
}

/** Skill info from the skills directory */
export interface SkillInfo {
  source: Source;
  category: string;
  name: string;
  description: string;
  tags: string[];
  /**
   * Token cost of this skill's index entry in the system prompt
   * (name + description + tags). Body content is NOT included — it
   * only loads on skill_view() and shows up as a tool result.
   */
  tokenEstimate: number;
}

/**
 * Read description/tags from a SKILL.md YAML frontmatter block.
 * Cheap — reads only the first ~2KB. Missing file / no `---` → empty.
 */
export function readSkillFrontmatter(source: Source): { description: string; tags: string[] } {
  try {
    const fd = openSync(source.file, "r");
    const buf = Buffer.alloc(2048);
    const n = readSync(fd, buf, 0, 2048, 0);
    closeSync(fd);
    const head = buf.toString("utf-8", 0, n);
    if (!head.startsWith("---")) return { description: "", tags: [] };
    const end = head.indexOf("\n---", 3);
    if (end < 0) return { description: "", tags: [] };
    const fm = parseYaml(head.slice(3, end)) as Record<string, unknown>;
    const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : [];
    return { description: String(fm.description ?? ""), tags };
  } catch {
    return { description: "", tags: [] };
  }
}

/** Per-skill telemetry sidecar record (~/.hermes/skills/.usage.json). */
export interface SkillUsage {
  use_count: number;
  view_count: number;
  patch_count: number;
  last_used_at: string | null;
  last_viewed_at: string | null;
  last_patched_at: string | null;
  created_at: string | null;
  archived_at: string | null;
  state: "active" | "stale" | "archived";
  pinned: boolean;
}

/**
 * Read ~/.hermes/skills/.usage.json. Keyed by skill name.
 * Returns empty record on any failure — absent sidecar is the default.
 */
export async function readSkillUsage(): Promise<Record<string, SkillUsage>> {
  try {
    const f = Bun.file(hermesPath("skills/.usage.json"));
    if (!(await f.exists())) return {};
    const raw = await f.json() as Record<string, Partial<SkillUsage>>;
    const out: Record<string, SkillUsage> = {};
    for (const [k, v] of Object.entries(raw ?? {})) {
      out[k] = {
        use_count: Number(v.use_count ?? 0),
        view_count: Number(v.view_count ?? 0),
        patch_count: Number(v.patch_count ?? 0),
        last_used_at: v.last_used_at ?? null,
        last_viewed_at: v.last_viewed_at ?? null,
        last_patched_at: v.last_patched_at ?? null,
        created_at: v.created_at ?? null,
        archived_at: v.archived_at ?? null,
        state: (v.state as SkillUsage["state"]) ?? "active",
        pinned: Boolean(v.pinned),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Curator scheduler state (~/.hermes/skills/.curator_state). */
export interface CuratorState {
  last_run_at: string | null;
  last_run_duration_seconds: number | null;
  last_run_summary: string | null;
  paused: boolean;
  run_count: number;
}

export async function readCuratorState(): Promise<CuratorState | null> {
  try {
    const f = Bun.file(hermesPath("skills/.curator_state"));
    if (!(await f.exists())) return null;
    const raw = await f.json() as Partial<CuratorState>;
    return {
      last_run_at: raw.last_run_at ?? null,
      last_run_duration_seconds: raw.last_run_duration_seconds ?? null,
      last_run_summary: raw.last_run_summary ?? null,
      paused: Boolean(raw.paused),
      run_count: Number(raw.run_count ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * Locate the newest curator run report — returns {dir, mtime} of the
 * directory under ~/.hermes/logs/curator/ with the latest mtime.
 * Returns null if none exist.
 */
export interface CuratorReportInfo {
  /** Source to the REPORT.md inside the newest run dir. */
  source: Source;
  /** Raw REPORT.md body, trimmed. */
  content: string;
  /** Run dir name, e.g. "20260430-120030". */
  runId: string;
}

export async function readLatestCuratorReport(): Promise<CuratorReportInfo | null> {
  try {
    const base = hermesPath("logs/curator");
    const entries = readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory());
    if (entries.length === 0) return null;
    // Run dirs are named YYYYMMDD-HHMMSS — lexicographic sort = chronological.
    entries.sort((a, b) => b.name.localeCompare(a.name));
    const runId = entries[0]!.name;
    const rel = `logs/curator/${runId}/REPORT.md`;
    const source = makeSource(rel);
    const body = await Bun.file(source.file).text();
    return { source, content: body.trim(), runId };
  } catch {
    return null;
  }
}

/** One curator run — id is the YYYYMMDD-HHMMSS dir name; counts come
 *  from run.json.counts; REPORT.md is lazy-loaded on expand. */
export type CuratorRun = {
  id: string
  at: number
  archived: number; consolidated: number; added: number
  before: number; after: number
}

export function listCuratorRuns(): CuratorRun[] {
  try {
    const base = hermesPath("logs/curator");
    return readdirSync(base, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name))
      .flatMap(e => {
        try {
          const fd = openSync(`${base}/${e.name}/run.json`, "r");
          const buf = Buffer.alloc(8192);
          const n = readSync(fd, buf);
          closeSync(fd);
          const j = JSON.parse(buf.toString("utf8", 0, n));
          const c = j.counts ?? {};
          return [{
            id: e.name,
            at: Date.parse(j.started_at ?? "") / 1000 || 0,
            archived: c.archived_this_run ?? 0,
            consolidated: c.consolidated_this_run ?? 0,
            added: c.added_this_run ?? 0,
            before: c.before ?? 0, after: c.after ?? 0,
          }];
        } catch { return [] }
      });
  } catch { return [] }
}

export async function readCuratorReport(id: string): Promise<string> {
  try {
    return (await Bun.file(hermesPath(`logs/curator/${id}/REPORT.md`)).text()).trim();
  } catch { return "" }
}

/** Per-skill curator event, projected out of run.json so DetailPanel
 *  can answer "what did curator do to *this* skill, and when". */
export type LineageEvent =
  | { kind: "transition"; run: string; at: number; from: string; to: string }
  | { kind: "absorbed";   run: string; at: number; sources: string[] }
  | { kind: "merged";     run: string; at: number; into: string; reason?: string }
  | { kind: "pruned";     run: string; at: number; reason?: string }
  | { kind: "added";      run: string; at: number }

export type LineageIndex = Map<string, LineageEvent[]>

type RunJson = {
  started_at?: string
  archived?: string[]
  added?: string[]
  consolidated?: { name: string; into: string; reason?: string }[]
  pruned?: { name: string; reason?: string }[]
  state_transitions?: { name: string; from: string; to: string }[]
}

/** Build a skill→events index across every run.json. Runs: dozens,
 *  payload: low-KB JSON each — call once per tab open. Newest-first. */
export function indexCuratorLineage(): LineageIndex {
  const out: LineageIndex = new Map()
  const push = (name: string, ev: LineageEvent) => {
    const a = out.get(name) ?? []
    a.push(ev); out.set(name, a)
  }
  try {
    const base = hermesPath("logs/curator")
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      try {
        const j = JSON.parse(readFileSync(`${base}/${e.name}/run.json`, "utf8")) as RunJson
        const at = Date.parse(j.started_at ?? "") / 1000 || 0
        const run = e.name
        // targets absorbing 1+ sources
        const into = new Map<string, string[]>()
        for (const c of j.consolidated ?? []) {
          push(c.name, { kind: "merged", run, at, into: c.into, reason: c.reason })
          into.set(c.into, [...(into.get(c.into) ?? []), c.name])
        }
        for (const [tgt, srcs] of into)
          push(tgt, { kind: "absorbed", run, at, sources: srcs })
        for (const t of j.state_transitions ?? [])
          push(t.name, { kind: "transition", run, at, from: t.from, to: t.to })
        for (const p of j.pruned ?? [])
          push(p.name, { kind: "pruned", run, at, reason: p.reason })
        for (const n of j.added ?? [])
          push(n, { kind: "added", run, at })
      } catch {}
    }
  } catch {}
  for (const a of out.values()) a.sort((x, y) => y.at - x.at)
  return out
}

/**
 * Cron-generated hermes-agent changelog digest (tji.3). The cron job
 * writes ~/.hermes/herm/changelog.md as `# hermes-agent — N new
 * commits` + bullets. Splash shows the first bullet; the "N behind"
 * count already comes from session.info.update_behind, so this only
 * needs to surface the prose.
 */
export type Changelog = { source: Source; headline: string; body: string }

export function readChangelog(): Changelog | null {
  try {
    const source = makeSource("herm/changelog.md");
    // Bun.file().text() is async; splash render is sync-first-frame,
    // so openSync/readSync to keep the hot path synchronous.
    const fd = openSync(source.file, "r");
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf);
    closeSync(fd);
    const body = buf.toString("utf8", 0, n).trim();
    const line = body.split("\n").find(l => /^[-*·]/.test(l.trim()));
    return { source, headline: line?.replace(/^[-*·]\s*/, "").trim() ?? "", body };
  } catch {
    return null;
  }
}

/** SOUL.md info */
export interface SoulInfo {
  source: Source;
  charCount: number;
  tokenEstimate: number;
  /** Raw SOUL.md body. Consumed by the Context drill-down detail panel. */
  content: string;
}

/** System prompt breakdown — full text for section parsing */
export interface SystemPromptInfo {
  source: Source;
  sessionId: string;
  text: string;
  totalChars: number;
  tokenEstimate: number;
}

/** Tool list with its source. */
export interface ToolsInfo {
  source: Source;
  tools: ToolInfo[];
}

/** Read and parse config.yaml */
export async function readConfig(): Promise<HermesConfig | null> {
  try {
    const file = Bun.file(hermesPath("config.yaml"));
    const text = await file.text();
    const raw = parseYaml(text);
    return {
      source: makeSource("config.yaml", "config.yaml"),
      model: {
        default: raw?.model?.default ?? "unknown",
        provider: raw?.model?.provider ?? "auto",
        base_url: raw?.model?.base_url ?? "",
        context_length: raw?.model?.context_length,
      },
      agent: {
        max_turns: raw?.agent?.max_turns ?? 60,
        reasoning_effort: raw?.agent?.reasoning_effort ?? "medium",
      },
      compression: {
        enabled: raw?.compression?.enabled ?? true,
        threshold: raw?.compression?.threshold ?? 0.5,
        target_ratio: raw?.compression?.target_ratio ?? 0.2,
        protect_last_n: raw?.compression?.protect_last_n ?? 20,
        summary_model: raw?.compression?.summary_model ?? "",
      },
      memory: {
        memory_enabled: raw?.memory?.memory_enabled ?? true,
        user_profile_enabled: raw?.memory?.user_profile_enabled ?? true,
        memory_char_limit: raw?.memory?.memory_char_limit ?? 2200,
        user_char_limit: raw?.memory?.user_char_limit ?? 1375,
        provider: raw?.memory?.provider ?? "",
        nudge_interval: raw?.memory?.nudge_interval ?? 10,
        flush_min_turns: raw?.memory?.flush_min_turns ?? 6,
      },
      display: {
        personality: raw?.display?.personality ?? "default",
        skin: raw?.display?.skin ?? "default",
        show_cost: raw?.display?.show_cost ?? false,
      },
      curator: {
        enabled: raw?.curator?.enabled ?? true,
        interval_hours: raw?.curator?.interval_hours ?? 168,
        stale_after_days: raw?.curator?.stale_after_days ?? 30,
        archive_after_days: raw?.curator?.archive_after_days ?? 90,
      },
      approvals: {
        destructive_slash_confirm: raw?.approvals?.destructive_slash_confirm ?? true,
      },
      gateway: {
        platforms: {
          api_server: raw?.gateway?.platforms?.api_server ?? undefined,
        },
      },
    };
  } catch {
    return null;
  }
}

/** Read a memory file (MEMORY.md or USER.md) with limit context */
export async function readMemoryFile(
  filename: "MEMORY.md" | "USER.md",
  charLimit: number,
): Promise<MemoryFileInfo | null> {
  try {
    const relative = `memories/${filename}`;
    const file = Bun.file(hermesPath(relative));
    const content = await file.text();
    const entryCount = content.split("§").filter((s) => s.trim()).length;
    return {
      source: makeSource(relative, filename),
      content,
      charCount: content.length,
      charLimit,
      usagePercent:
        charLimit > 0 ? Math.round((content.length / charLimit) * 100) : 0,
      entryCount,
    };
  } catch {
    return null;
  }
}

/**
 * Read optional legacy sessions/sessions.json.
 *
 * state.db is canonical for persisted sessions. This file is only present
 * when Hermes is configured to emit debug/legacy snapshots, so absence is
 * expected and must read as an empty map.
 */
export async function readLiveSessions(): Promise<
  Record<string, LiveSession>
> {
  try {
    const file = Bun.file(hermesPath("sessions/sessions.json"));
    if (!(await file.exists())) return {};
    const text = await file.text();
    return JSON.parse(text);
  } catch {
    return {};
  }
}
// Everything session-shaped lives in sessions-db.ts now — one readonly
// handle, one parent→child classification rule, shared SQL. These
// aliases preserve the old hermes-home API for home/store.ts and
// test/hermes-home-sessions.test.ts; new code should import from
// sessions-db directly.

import {
  roots as _roots, children as _children, lineage as _lineage,
  search as _search,
} from "./sessions-db"
export type { LineageInfo, SessionHit } from "./sessions-db"
export const queryRecentSessions = _roots
export const querySubagents = _children
export const queryLineage = _lineage
export const searchSessions = _search

/** Memory provider info — what's configured and available */
export interface MemoryProviderInfo {
  name: string;
  active: boolean;
  config: Record<string, string | number | boolean>;
}

// Per-provider local config/state file locations under HERMES_HOME.
// This is lookup data, not an enumeration — discovery comes from
// discoverMemoryProviders() below.
const MEMORY_CFG_FILES: Record<string, string[]> = {
  mem0: ["mem0.json"],
  honcho: ["honcho.json"],
  hindsight: ["hindsight/config.json"],
  supermemory: ["supermemory.json"],
  holographic: ["holographic.db"],
};

/** Scan the bundled hermes-agent memory-plugin dir for provider names
    (mirrors plugins/memory/__init__.py discover's dir walk). User-
    installed providers in $HERMES_HOME/plugins/ aren't distinguished
    from non-memory plugins without importing them — wait for the
    memory.providers RPC for those. */
function discoverMemoryProviders(): string[] {
  const names = new Set<string>(["builtin"]);
  try {
    for (const e of readdirSync(hermesPath("hermes-agent/plugins/memory"), { withFileTypes: true }))
      if (e.isDirectory() && !e.name.startsWith("_")) names.add(e.name);
  } catch {}
  return [...names];
}

/** Read memory provider configs from ~/.hermes/ — one entry per
    discovered provider, with any local config file parsed in. */
export async function readMemoryProviders(
  activeProvider: string,
): Promise<MemoryProviderInfo[]> {
  const out: MemoryProviderInfo[] = [];
  for (const name of discoverMemoryProviders()) {
    if (name === "builtin") { out.push({ name, active: true, config: {} }); continue; }
    const cfg: Record<string, string | number | boolean> = {};
    for (const f of MEMORY_CFG_FILES[name] ?? []) {
      try {
        const file = Bun.file(hermesPath(f));
        if (f.endsWith(".json")) {
          const raw = await file.json();
          for (const [k, v] of Object.entries(raw)) {
            if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
              // Redact keys/tokens
              const lower = k.toLowerCase();
              if (lower.includes("key") || lower.includes("token") || lower.includes("secret")) {
                cfg[k] = typeof v === "string" ? `${v.slice(0, 4)}...` : v;
              } else {
                cfg[k] = v;
              }
            }
          }
        } else {
          const st = await file.stat();
          if (st) cfg["db_size"] = `${Math.round(st.size / 1024)}KB`;
        }
      } catch {}
    }
    out.push({ name, active: name === activeProvider, config: cfg });
  }
  return out;
}

/** Read SOUL.md */
export async function readSoul(): Promise<SoulInfo | null> {
  try {
    const file = Bun.file(hermesPath("SOUL.md"));
    const text = await file.text();
    return {
      source: makeSource("SOUL.md"),
      charCount: text.length,
      tokenEstimate: tokenCount(text),
      content: text,
    };
  } catch {
    return null;
  }
}

/** Read tool list from the most recent optional legacy session JSON. */
export async function readToolsFromLatestSession(): Promise<ToolsInfo | null> {
  try {
    const dir = hermesPath("sessions");
    if (!existsSync(dir)) return null;
    const glob = new Bun.Glob("session_*.json");
    let latestPath = "";
    let latestTime = 0;

    for await (const path of glob.scan({ cwd: dir })) {
      const file = Bun.file(hermesPath(`sessions/${path}`));
      const stat = await file.stat();
      if (stat && stat.mtimeMs > latestTime) {
        latestTime = stat.mtimeMs;
        latestPath = path;
      }
    }

    if (!latestPath) return null;

    const relative = `sessions/${latestPath}`;
    const file = Bun.file(hermesPath(relative));
    const data = await file.json();
    type RawTool = { function?: { name?: string; description?: string; parameters?: unknown } };
    const tools: ToolInfo[] = (data.tools || []).map((t: RawTool) => ({
      name: t?.function?.name ?? "unknown",
      descriptionLength: (t?.function?.description ?? "").length,
      paramsLength: JSON.stringify(t?.function?.parameters ?? {}).length,
    }));
    return {
      source: makeSource(relative, latestPath),
      tools,
    };
  } catch {
    return null;
  }
}

/** Read system prompt from the most recent state.db session that has a full one */
export function readSystemPromptInfo(): SystemPromptInfo | null {
  try {
    const db = new Database(hermesPath("state.db"), { readwrite: true, create: false });
    // Short prompts (~700 chars) are the generic fallback without SOUL/memory/skills.
    const row = db
      .query(
        `SELECT id, system_prompt
         FROM sessions
         WHERE system_prompt IS NOT NULL AND length(system_prompt) > 1000
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get() as { id: string; system_prompt: string } | null;
    db.close();
    if (!row) return null;
    return {
      source: makeSource("state.db"),
      sessionId: row.id,
      text: row.system_prompt,
      totalChars: row.system_prompt.length,
      tokenEstimate: tokenCount(row.system_prompt),
    };
  } catch {
    return null;
  }
}

export interface CronOutput {
  at: Date
  path: string
  text: string
}

/** Read the most recent cron output for a job, tail-truncated. */
export async function readCronOutput(
  jobId: string,
  tailLines = 40,
): Promise<CronOutput | null> {
  const dir = hermesPath(`cron/output/${jobId}`);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const md = entries.filter(f => f.endsWith(".md")).sort().reverse();
  if (md.length === 0) return null;
  const path = `${dir}/${md[0]}`;
  const full = await Bun.file(path).text();
  const lines = full.trimEnd().split("\n");
  const text =
    lines.length > tailLines
      ? `…(${lines.length - tailLines} earlier lines)\n` +
        lines.slice(-tailLines).join("\n")
      : full.trimEnd();
  const st = await stat(path);
  return { at: st.mtime, path, text };
}

const envPath = () => hermesPath(".env")

const envKey = (key: string) => key.replace(/^export\s+/, "").trim()

/** Parse ~/.hermes/.env into Record<string, string> */
export async function readEnvFile(): Promise<Record<string, string>> {
  try {
    const text = await Bun.file(envPath()).text();
    const vars: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      vars[envKey(trimmed.slice(0, eq))] = trimmed.slice(eq + 1);
    }
    return vars;
  } catch {
    return {};
  }
}

/** Update or append a KEY=VALUE in ~/.hermes/.env */
export async function writeEnvVar(key: string, value: string): Promise<void> {
  let text = "";
  try {
    text = await Bun.file(envPath()).text();
  } catch { /* file may not exist */ }

  const lines = text.split("\n");
  let found = false;
  const updated = lines.map(line => {
    const eq = line.trim().indexOf("=")
    if (eq >= 1 && envKey(line.trim().slice(0, eq)) === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) updated.push(`${key}=${value}`);

  await Bun.write(envPath(), updated.join("\n"));
}

/** Remove a key from ~/.hermes/.env */
export async function removeEnvVar(key: string): Promise<void> {
  let text = "";
  try {
    text = await Bun.file(envPath()).text();
  } catch { return; }

  const lines = text.split("\n").filter(line => {
    const eq = line.trim().indexOf("=")
    return eq < 1 || envKey(line.trim().slice(0, eq)) !== key
  });
  await Bun.write(envPath(), lines.join("\n"));
}

export const ENV_CATALOG: ReadonlyArray<{ category: string; keys: string[] }> = [
  {
    category: "LLM Providers",
    keys: [
      "ANTHROPIC_API_KEY", "ARCEEAI_API_KEY", "DEEPSEEK_API_KEY",
      "FIREWORKS_API_KEY", "GEMINI_API_KEY", "GLM_API_KEY", "GMI_API_KEY",
      "GOOGLE_API_KEY", "GROQ_API_KEY", "KIMI_API_KEY", "LM_API_KEY",
      "MINIMAX_API_KEY", "MISTRAL_API_KEY", "NOUS_API_KEY", "NVIDIA_API_KEY",
      "OPENAI_API_KEY", "OPENROUTER_API_KEY", "STEPFUN_API_KEY",
      "TOGETHER_API_KEY", "VERTEX_CREDENTIALS_PATH", "XAI_API_KEY",
      "ZAI_API_KEY", "Z_AI_API_KEY",
    ],
  },
  {
    category: "Tool API Keys",
    keys: [
      "AGENT_BROWSER_ENGINE", "BRAVE_SEARCH_API_KEY", "BROWSERBASE_API_KEY",
      "BROWSERBASE_PROJECT_ID", "BROWSER_USE_API_KEY", "CAMOFOX_API_KEY",
      "CAMOFOX_URL", "ELEVENLABS_API_KEY", "EXA_API_KEY", "FAL_KEY",
      "FIRECRAWL_API_KEY", "FIRECRAWL_API_URL", "FIRECRAWL_BROWSER_TTL",
      "KREA_API_KEY", "OPENVIKING_API_KEY", "OPENVIKING_ENDPOINT",
      "SEARXNG_URL", "TAVILY_API_KEY", "TOOL_GATEWAY_DOMAIN",
      "TOOL_GATEWAY_SCHEME", "TOOL_GATEWAY_USER_TOKEN",
    ],
  },
  {
    category: "Messaging",
    keys: [
      "DISCORD_ALLOWED_USERS", "DISCORD_BOT_TOKEN", "DISCORD_REPLY_TO_MODE",
      "SLACK_ALLOWED_USERS", "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN",
      "TELEGRAM_ALLOWED_USERS", "TELEGRAM_BOT_TOKEN", "TELEGRAM_PROXY",
    ],
  },
  {
    category: "Agent",
    keys: [
      "API_SERVER_KEY", "BRV_API_KEY", "HERMES_LANGFUSE_BASE_URL",
      "HERMES_LANGFUSE_PUBLIC_KEY", "HERMES_LANGFUSE_SECRET_KEY",
      "HINDSIGHT_API_KEY", "HINDSIGHT_API_URL", "MEM0_API_KEY",
      "RETAINDB_API_KEY", "RETAINDB_BASE_URL", "SUPERMEMORY_API_KEY",
    ],
  },
];

export * as HermesHome from "./hermes-home"
