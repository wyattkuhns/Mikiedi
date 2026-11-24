/**
 * Workspace-root assistant files exposed as bridge pages.
 *
 * The assistant's core state files (NOW, SOUL, IDENTITY, HEARTBEAT) live at
 * the workspace root rather than in memory/concepts, but they are exactly the
 * kind of content a SilverBullet author wants to read and edit through the
 * bridge. They are exposed as lowercase slugs per the platform's slug rules;
 * the mapping to the on-disk filename is fixed here.
 *
 * Root pages differ from concept pages in two ways, both enforced by the
 * callers of these helpers:
 *   - They are plain Markdown without frontmatter (see `isRootSlug` in
 *     frontmatter.ts), so concept-page validation does not apply.
 *   - They cannot be deleted through the bridge: they are load-bearing
 *     assistant files, not corpus entries.
 */
import { join } from "node:path";

export interface RootPageFile {
  slug: string;
  /** Path relative to the Cadet workspace root. */
  filename: string;
}

export const ROOT_PAGE_FILES: readonly RootPageFile[] = [
  { slug: "now", filename: "NOW.md" },
  { slug: "soul", filename: "SOUL.md" },
  { slug: "identity", filename: "IDENTITY.md" },
  { slug: "heartbeat", filename: "HEARTBEAT.md" },
];

/** Absolute path of the workspace-root file for a root slug, or null. */
export function rootFilePath(workspaceDir: string, slug: string): string | null {
  if (!workspaceDir) return null;
  const hit = ROOT_PAGE_FILES.find((r) => r.slug === slug);
  return hit ? join(workspaceDir, hit.filename) : null;
}

export function isRootSlug(slug: string): boolean {
  return ROOT_PAGE_FILES.some((r) => r.slug === slug);
}
