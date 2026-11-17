/**
 * Full-byte SHA-256 revision identity, per the Mikiedi conflict model:
 * hashes cover the complete page bytes including frontmatter, so a
 * frontmatter-only edit is never mistaken for "unchanged".
 */
import { createHash } from "node:crypto";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Short display form used in UIs and journal lines. */
export function shortHash(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 12) : "(none)";
}
