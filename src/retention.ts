/**
 * Retention policy parsing and pruning for Mikiedi v0.3.
 *
 * Two independent retention categories, each expressed as a compact spec
 * string the SB library composes from its amount+unit config fields:
 *   "forever"   keep everything (default)
 *   "never"     keep nothing / log nothing
 *   "<n><unit>" where unit is s | m | h | d | y (365.25-day years)
 *
 * Categories:
 *   log      — the journal (operational log). "never" stops new journal
 *              appends; pruning an existing journal archives TTL-expired
 *              lines to journal-archive.jsonl (never silently destroyed).
 *   versions — the version store (per-page content history backing the
 *              panel's diff viewer and undo/redo). "never" records no
 *              versions, which makes undo/redo unavailable; CAS safety,
 *              snapshots-when-deleting semantics, and atomic writes are
 *              unaffected.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type Retention =
  | { kind: "forever" }
  | { kind: "never" }
  | { kind: "ttl"; ms: number };

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  y: 365.25 * 86_400_000,
};

export function parseRetention(spec: unknown, fallback: Retention = { kind: "forever" }): Retention {
  if (typeof spec !== "string") return fallback;
  const s = spec.trim().toLowerCase();
  if (s === "" || s === "forever") return { kind: "forever" };
  if (s === "never") return { kind: "never" };
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|y)$/);
  if (!match) return fallback;
  const ms = Number(match[1]) * UNIT_MS[match[2]];
  return ms > 0 ? { kind: "ttl", ms } : fallback;
}

/** True when a record with this age should be kept. */
export function keep(ageMs: number, r: Retention): boolean {
  if (r.kind === "forever") return true;
  if (r.kind === "never") return false;
  return ageMs < r.ms;
}

// ---------------------------------------------------------------------------
// Journal retention
// ---------------------------------------------------------------------------

export interface PruneReport {
  journalArchived: number;
  journalCleared: boolean;
  versionsRemoved: number;
  slugsTouched: string[];
}

/**
 * Prune the journal per the log-retention policy. TTL: lines older than the
 * cutoff are MOVED to journal-archive.jsonl (data is preserved, only the
 * hot log shrinks). never: the whole hot journal is archived and emptied.
 * forever: no-op.
 */
export function pruneJournal(dataDir: string, r: Retention, nowMs: number = Date.now()): { archived: number; cleared: boolean } {
  const path = join(dataDir, "journal.jsonl");
  if (!existsSync(path)) return { archived: 0, cleared: false };
  if (r.kind === "forever") return { archived: 0, cleared: false };
  const lines = readFileSync(path, "utf8").trimEnd().split("\n").filter((l) => l.trim() !== "");
  const now = nowMs;
  const keepLines: string[] = [];
  const dropLines: string[] = [];
  for (const line of lines) {
    let at = "";
    try {
      at = JSON.parse(line).at ?? "";
    } catch {
      at = "";
    }
    const ts = Date.parse(at);
    const age = Number.isFinite(ts) ? now - ts : Number.NaN;
    if (r.kind === "never" || (Number.isFinite(age) && !keep(age, r))) dropLines.push(line);
    else keepLines.push(line);
  }
  if (dropLines.length === 0) return { archived: 0, cleared: false };
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(join(dataDir, "journal-archive.jsonl"), dropLines.join("\n") + "\n", "utf8");
  writeFileSync(path, keepLines.length > 0 ? keepLines.join("\n") + "\n" : "", "utf8");
  return { archived: dropLines.length, cleared: keepLines.length === 0 };
}

// ---------------------------------------------------------------------------
// Version store retention
// ---------------------------------------------------------------------------

/** Directory name for a slug: folder slugs join on "." (dots are invalid in slugs). */
export function slugDirName(slug: string): string {
  return slug.split("/").join(".");
}

export function versionsRoot(dataDir: string): string {
  return join(dataDir, "versions");
}

/**
 * Remove version records older than the retention cutoff. "never" removes
 * the entire version store (index + content files, per slug); the user asked
 * to keep no history. Returns the number of version entries removed.
 */
export function pruneVersions(dataDir: string, r: Retention, nowMs: number = Date.now()): { removed: number; slugs: string[] } {
  const root = versionsRoot(dataDir);
  if (!existsSync(root)) return { removed: 0, slugs: [] };
  const now = nowMs;
  let removed = 0;
  const slugs: string[] = [];
  for (const dir of readdirSync(root)) {
    const indexPath = join(root, dir, "index.json");
    if (!existsSync(indexPath)) continue;
    let entries: Array<{ ts: string }> = [];
    try {
      entries = JSON.parse(readFileSync(indexPath, "utf8"));
    } catch {
      continue;
    }
    if (r.kind === "never") {
      removed += entries.length;
      slugs.push(dir);
      rmSync(join(root, dir), { recursive: true, force: true });
      continue;
    }
    const kept = entries.filter((e) => {
      const ts = Date.parse(e.ts ?? "");
      return !Number.isFinite(ts) || now - ts < r.ms;
    });
    if (kept.length === entries.length) continue;
    removed += entries.length - kept.length;
    slugs.push(dir);
    if (kept.length === 0) {
      rmSync(join(root, dir), { recursive: true, force: true });
    } else {
      writeFileSync(indexPath, JSON.stringify(kept, null, 2), "utf8");
    }
  }
  return { removed, slugs };
}

/** Applies both retention categories; returns what happened for the response. */
export function applyRetention(dataDir: string, log: Retention, versions: Retention, nowMs: number = Date.now()): PruneReport {
  const j = pruneJournal(dataDir, log, nowMs);
  const v = pruneVersions(dataDir, versions, nowMs);
  return {
    journalArchived: j.archived,
    journalCleared: j.cleared,
    versionsRemoved: v.removed,
    slugsTouched: v.slugs,
  };
}
