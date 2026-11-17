/**
 * Append-only JSONL journal of every bridge operation that changed (or
 * deliberately did not change) canonical state. One line per entry. This is
 * the audit trail the recovery procedure replays from.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface JournalEntry {
  at: string;
  op: string;
  slug: string;
  outcome: string;
  prevHash?: string | null;
  newHash?: string | null;
  detail?: string;
}

export function appendJournal(dataDir: string, entry: JournalEntry): void {
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(join(dataDir, "journal.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
}

export function readJournalTail(dataDir: string, count: number): JournalEntry[] {
  try {
    const lines = readFileSync(join(dataDir, "journal.jsonl"), "utf8").trimEnd().split("\n");
    const out: JournalEntry[] = [];
    for (let i = Math.max(0, lines.length - count); i < lines.length; i++) {
      if (lines[i].trim() === "") continue;
      try {
        out.push(JSON.parse(lines[i]));
      } catch {
        out.push({ at: "", op: "corrupt-line", slug: "", outcome: String(lines[i]).slice(0, 120) });
      }
    }
    return out;
  } catch {
    return [];
  }
}
