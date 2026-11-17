/**
 * Cadet concept-page slug rules, enforced exactly as the platform's
 * page-store validates them: lowercase ASCII letters, digits and hyphens;
 * at most 80 characters per `/`-separated segment; at most 200 characters
 * total; no leading/trailing slash; no empty segments; no `..`.
 */
import { join, resolve, sep } from "node:path";

const SEGMENT_RE = /^[a-z0-9-]+$/;

/** Returns an error message for an invalid slug, or null when valid. */
export function validateSlug(slug: unknown): string | null {
  if (typeof slug !== "string" || slug.length === 0) return "slug must be a non-empty string";
  if (slug.length > 200) return `slug exceeds 200 characters (${slug.length})`;
  if (slug.startsWith("/") || slug.endsWith("/") || slug.includes("//")) {
    return "slug must not start or end with a slash, or contain empty segments";
  }
  if (slug.includes("..")) return "slug must not contain '..'";
  for (const segment of slug.split("/")) {
    if (segment.length > 80) return `slug segment "${segment}" exceeds 80 characters`;
    if (!SEGMENT_RE.test(segment)) {
      return `slug segment "${segment}" may only contain lowercase letters, digits, and hyphens`;
    }
  }
  return null;
}

/** Absolute file path for a slug, verified to stay inside conceptsDir. */
export function pagePath(conceptsDir: string, slug: string): string {
  const base = resolve(conceptsDir);
  const path = resolve(join(base, `${slug}.md`));
  if (path !== base && !path.startsWith(base + sep)) {
    throw new Error(`Mikiedi: slug escapes the concept-page directory: ${slug}`);
  }
  return path;
}
