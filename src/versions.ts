/**
 * Version store — the per-page content history backing the Mikiedi panel's
 * diff viewer and undo/redo (v0.3).
 *
 * Layout under the plugin data dir:
 *   versions/<slug-dir>/index.json   chronological entries (see below)
 *   versions/<slug-dir>/<ts>-<shorthash>.md   full content of that state
 *
 * <slug-dir> is the slug with "/" joined to "." (dots never appear in valid
 * slugs, so the mapping is collision-free). Deleted states are tombstones:
 * an entry with hash null and no content file. Entries are appended by the
 * op engine while holding the op lock; readers may run unlocked but only
 * tolerate a missing/partial index.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex, shortHash } from "./revision.ts";
import { slugDirName, versionsRoot } from "./retention.ts";

export interface VersionEntry {
  /** ISO timestamp of the state change. */
  ts: string;
  /** Full-byte SHA-256 of the content, or null for a tombstone (deleted). */
  hash: string | null;
  /** Which op produced this state: publish | delete | resolve | undo | redo | pre-existing. */
  op: string;
  outcome: string;
  /** Editor session id that produced it, when known. */
  sessionId?: string;
  /** Free-text note (op detail). */
  note?: string;
}

function slugDir(dataDir: string, slug: string): string {
  return join(versionsRoot(dataDir), slugDirName(slug));
}

function indexPath(dataDir: string, slug: string): string {
  return join(slugDir(dataDir, slug), "index.json");
}

export function readVersionIndex(dataDir: string, slug: string): VersionEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(indexPath(dataDir, slug), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Records a state into the version store. Dedupes on the previous entry's
 * hash: an unchanged state is not recorded twice (retry idempotency). */
export function recordVersion(
  dataDir: string,
  slug: string,
  content: string | null,
  entry: Omit<VersionEntry, "hash"> & { hash?: string | null },
): VersionEntry | null {
  const contentHash = content === null ? null : sha256Hex(content);
  const index = readVersionIndex(dataDir, slug);
  const last = index[index.length - 1];
  if (last && last.hash === contentHash) return null; // identical state; no new version

  const full: VersionEntry = {
    ts: entry.ts,
    hash: contentHash,
    op: entry.op,
    outcome: entry.outcome,
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    ...(entry.note ? { note: entry.note } : {}),
  };
  const dir = slugDir(dataDir, slug);
  mkdirSync(dir, { recursive: true });
  if (content !== null) {
    const name = `${entry.ts.replace(/[:.]/g, "-")}-${shortHash(contentHash!)}.md`;
    writeFileSync(join(dir, name), content, "utf8");
    (full as VersionEntry & { file?: string }).file = name;
  }
  index.push(full);
  writeFileSync(indexPath(dataDir, slug), JSON.stringify(index, null, 2), "utf8");
  return full;
}

/** Reads the content of a recorded state. Tombstone (hash null) → null. */
export function readVersionContent(dataDir: string, slug: string, entry: VersionEntry): string | null {
  if (entry.hash === null) return null;
  const file = (entry as VersionEntry & { file?: string }).file;
  if (file) {
    try {
      return readFileSync(join(slugDir(dataDir, slug), file), "utf8");
    } catch {
      // fall through to directory scan
    }
  }
  // Older entry without a recorded file name: scan for the ts-prefix.
  const dir = slugDir(dataDir, slug);
  if (!existsSync(dir)) return null;
  const prefix = entry.ts.replace(/[:.]/g, "-");
  for (const f of readdirSync(dir)) {
    if (f.startsWith(prefix) && f.endsWith(".md")) {
      const content = readFileSync(join(dir, f), "utf8");
      if (sha256Hex(content) === entry.hash) return content;
    }
  }
  return null;
}

/** Finds a recorded state by full hash (most recent match first). */
export function findVersionByHash(dataDir: string, slug: string, hash: string): VersionEntry | undefined {
  const index = readVersionIndex(dataDir, slug);
  for (let i = index.length - 1; i >= 0; i--) {
    if (index[i].hash === hash) return index[i];
  }
  return undefined;
}
