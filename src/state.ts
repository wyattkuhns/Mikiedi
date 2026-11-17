/**
 * Durable bridge state, held in the plugin's private data directory
 * (survives plugin upgrades; exported before uninstall per Cadet lifecycle).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Baseline {
  /** Full-byte SHA-256 of the canonical page at the time the baseline was recorded. */
  hash: string;
  at: string;
}

export interface ConflictRecord {
  at: string;
  sbHash: string | null;
  cadetHash: string | null;
  artifactDir: string;
}

export interface DeletionRecord {
  at: string;
  hash: string;
}

export interface BridgeState {
  version: 1;
  baselines: Record<string, Baseline>;
  conflicts: Record<string, ConflictRecord>;
  deleted: Record<string, DeletionRecord>;
  /**
   * Pages whose conflict was resolved as "keep-cadet". While set, a stale
   * editor copy cannot republish over the kept version: the editor must
   * refresh first (sync returns "update" until it matches, which clears
   * the marker). This keeps every override explicit against the displayed
   * current revision.
   */
  resolvedKeep: Record<string, { at: string; hash: string }>;
  lastRefresh: { at: string; ok: boolean; detail: string } | null;
  pendingRefresh: boolean;
}

export function emptyState(): BridgeState {
  return {
    version: 1,
    baselines: {},
    conflicts: {},
    deleted: {},
    resolvedKeep: {},
    lastRefresh: null,
    pendingRefresh: false,
  };
}

export function loadState(dataDir: string): BridgeState {
  const path = join(dataDir, "state.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && parsed.version === 1) {
      return {
        version: 1,
        baselines: parsed.baselines ?? {},
        conflicts: parsed.conflicts ?? {},
        deleted: parsed.deleted ?? {},
        resolvedKeep: parsed.resolvedKeep ?? {},
        lastRefresh: parsed.lastRefresh ?? null,
        pendingRefresh: Boolean(parsed.pendingRefresh),
      };
    }
  } catch {
    // Missing or unreadable state: start fresh. Snapshots and the journal
    // still exist, so nothing is lost that the recovery procedure needs.
  }
  return emptyState();
}

export function saveState(dataDir: string, state: BridgeState): void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "state.json");
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
}

export function ensureDataDir(dataDir: string): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
}
