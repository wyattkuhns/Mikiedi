/**
 * File operations against the canonical concept-page store and the plugin's
 * private data directory (snapshots, conflict artifacts).
 *
 * Writes are atomic (temp file + rename) and preserve the ownership of the
 * replaced file (or of the directory for new files) so the bridge never
 * leaves pages unreadable to other writers of the store.
 */
import {
  chownSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pagePath } from "./slugs.ts";

export function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function preserveOwnership(target: string, tmpPath: string, hadPrevious: boolean): void {
  try {
    // Best effort: only root can chown, and the common case is that the
    // bridge already runs as the same user as every other writer of the
    // store. This exists so a root-run bridge cannot leave pages owned by
    // root and unreadable to the daemon's normal user (paid for 2026-11-14).
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      const source = hadPrevious ? target : join(target, "..");
      const st = statSync(source);
      chownSync(tmpPath, st.uid, st.gid);
    }
  } catch {
    // Ownership mirroring is best effort; the write itself already happened.
  }
}

/** Atomic page write. Returns the absolute path written. */
export function writePageAtomic(conceptsDir: string, slug: string, content: string): string {
  const target = pagePath(conceptsDir, slug);
  mkdirSync(join(target, ".."), { recursive: true });
  const hadPrevious = existsSync(target);
  const tmp = join(target, "..", `.${basename(target)}.mikiedi-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, content, { encoding: "utf8", mode: hadPrevious ? statSync(target).mode & 0o777 : 0o644 });
  preserveOwnership(target, tmp, hadPrevious);
  renameSync(tmp, target);
  return target;
}

/** Store a pre-image snapshot before replacing or deleting a page. */
export function snapshotPage(dataDir: string, slug: string, content: string, hash: string, iso: string): string {
  const dir = join(dataDir, "snapshots", slug);
  mkdirSync(dir, { recursive: true });
  const stamp = iso.replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}-${hash.slice(0, 8)}.md`);
  writeFileSync(path, content, "utf8");
  return path;
}

export interface ConflictArtifact {
  artifactDir: string;
  sbPath: string;
  cadetPath: string;
}

/** Persist both sides of a conflict verbatim, plus a small metadata note. */
export function writeConflictArtifact(
  dataDir: string,
  slug: string,
  versions: { sb: string; cadet: string },
  meta: Record<string, unknown>,
  iso: string,
): ConflictArtifact {
  const dir = join(dataDir, "conflicts", slug, iso.replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const sbPath = join(dir, "silverbullet.md");
  const cadetPath = join(dir, "cadet.md");
  writeFileSync(sbPath, versions.sb, "utf8");
  writeFileSync(cadetPath, versions.cadet, "utf8");
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ slug, at: iso, ...meta }, null, 2), "utf8");
  return { artifactDir: dir, sbPath, cadetPath };
}

export interface ConceptSummary {
  slug: string;
  size: number;
  mtimeIso: string;
}

/** List every concept page under conceptsDir (recursing into folder slugs). */
export function listConceptPages(conceptsDir: string): ConceptSummary[] {
  const out: ConceptSummary[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, prefix === "" ? entry.name : `${prefix}/${entry.name}`);
      } else if (entry.name.endsWith(".md")) {
        const st = statSync(full);
        out.push({
          slug: prefix === "" ? entry.name.slice(0, -3) : `${prefix}/${entry.name.slice(0, -3)}`,
          size: st.size,
          mtimeIso: st.mtime.toISOString(),
        });
      }
    }
  };
  walk(conceptsDir, "");
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}
