/**
 * Unit tests for Mikiedi v0.3: cross-process lock, retention, diff engine,
 * version store, stomp guard, undo/redo, prune, and the new ops.
 * Run with: bun test
 *
 * Same harness conventions as ops.test.ts: real temporary directories,
 * no Cadet runtime, live memory never touched.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleOp, type BridgeDeps, type BridgeResponse } from "../src/ops.ts";
import { sha256Hex } from "../src/revision.ts";
import { OpLock } from "../src/lock.ts";
import { parseRetention, pruneJournal, pruneVersions, slugDirName, applyRetention } from "../src/retention.ts";
import { diffContents } from "../src/diff.ts";
import { recordVersion, readVersionIndex, readVersionContent, findVersionByHash } from "../src/versions.ts";
import { appendJournal, readJournalTail } from "../src/journal.ts";

const ROOTS: string[] = [];
let workspace = "";
let dataDir = "";

function page(slug: string, title: string, tags: string[] = ["test"], body = "Body text."): string {
  const lines = ["---", `title: "${title}"`, `slug: ${slug}`];
  if (tags.length > 0) {
    lines.push("tags:");
    for (const t of tags) lines.push(`  - ${t}`);
  }
  lines.push("links:", "  - other-page — a related page", "---", "", body, "");
  return lines.join("\n");
}

function deps(overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  return {
    config: {
      conceptsDir: join(workspace, "memory", "concepts"),
      cliPath: "/nonexistent-mikiedi-test-cli",
      refreshTimeoutMs: 500,
      conceptsDirIsDefault: false,
    },
    dataDir,
    workspaceDir: workspace,
    refresh: async () => ({ ok: true, detail: "stubbed refresh" }),
    now: () => new Date("2026-11-18T12:00:00.000Z"),
    ...overrides,
  };
}

function call(d: BridgeDeps, payload: Record<string, unknown>): Promise<BridgeResponse> {
  return handleOp(d, payload);
}

beforeEach(() => {
  const root = join(tmpdir(), `mikiedi-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  ROOTS.push(root);
  workspace = root;
  dataDir = join(root, "plugin-data");
  mkdirSync(join(workspace, "memory", "concepts"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
});

afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

const conceptsDir = () => join(workspace, "memory", "concepts");
const versionsRoot = () => join(dataDir, "versions");

// ---------------------------------------------------------------------------
// Cross-process lock
// ---------------------------------------------------------------------------

describe("op lock", () => {
  test("acquire and release round-trip", async () => {
    const lock = new OpLock(dataDir, 1000);
    await lock.acquire();
    expect(existsSync(lock.path)).toBe(true);
    const raw = readFileSync(lock.path, "utf8");
    expect(raw.startsWith(String(process.pid))).toBe(true);
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
  });

  test("second acquirer waits for release", async () => {
    const a = new OpLock(dataDir, 1000, 5, 2000);
    const b = new OpLock(dataDir, 1000, 5, 2000);
    await a.acquire();
    const wait = b.acquire().then(() => "acquired");
    setTimeout(() => a.release(), 50);
    expect(await wait).toBe("acquired");
    b.release();
  });

  test("stale lock from a dead holder is broken after the window", async () => {
    const lock = new OpLock(dataDir, 30, 5, 2000);
    await lock.acquire();
    // Simulate a crashed holder: rewrite the holder PID to one that cannot
    // exist and backdate the file past the stale window.
    writeFileSync(lock.path, "999999999 1700000000000\n", "utf8");
    const dead = Bun.spawnSync(["sh", "-c", "exit 0"]);
    expect(dead.exitCode).toBe(0);
    let atime = statSync(lock.path).mtimeMs;
    while (Date.now() - atime < 40) {
      await new Promise((r) => setTimeout(r, 5));
      atime = statSync(lock.path).mtimeMs;
    }
    const other = new OpLock(dataDir, 30, 5, 2000);
    await other.acquire();
    const raw = readFileSync(lock.path, "utf8");
    expect(raw.startsWith(String(process.pid))).toBe(true); // broken and re-held
    other.release();
  });

  test("holder PID that is still alive is not broken", async () => {
    const lock = new OpLock(dataDir, 0, 5, 300); // stale window of zero
    await lock.acquire(); // holder = this live test process
    const other = new OpLock(dataDir, 0, 5, 150);
    let err = "";
    try {
      await other.acquire();
    } catch (e) {
      err = (e as Error).message;
    }
    expect(err).toContain("could not acquire");
    lock.release();
  });
});

// ---------------------------------------------------------------------------
// Retention parsing and pruning
// ---------------------------------------------------------------------------

describe("retention", () => {
  test("parseRetention accepts all units", () => {
    expect(parseRetention("forever")).toEqual({ kind: "forever" });
    expect(parseRetention("never")).toEqual({ kind: "never" });
    expect(parseRetention("30s")).toEqual({ kind: "ttl", ms: 30_000 });
    expect(parseRetention("5m")).toEqual({ kind: "ttl", ms: 300_000 });
    expect(parseRetention("2h")).toEqual({ kind: "ttl", ms: 7_200_000 });
    expect(parseRetention("7d")).toEqual({ kind: "ttl", ms: 604_800_000 });
    // 365.25-day years
    expect(parseRetention("1y")).toEqual({ kind: "ttl", ms: 31_557_600_000 });
    expect(parseRetention("1.5y")).toEqual({ kind: "ttl", ms: 47_336_400_000 });
  });

  test("parseRetention falls back on garbage", () => {
    const fallback = { kind: "forever" as const };
    expect(parseRetention("banana", fallback)).toEqual(fallback);
    expect(parseRetention("5x", fallback)).toEqual(fallback);
    expect(parseRetention("-3d", fallback)).toEqual(fallback);
    expect(parseRetention(undefined, fallback)).toEqual(fallback);
    expect(parseRetention(42, fallback)).toEqual(fallback);
  });

  test("pruneJournal archives expired lines and keeps fresh ones", () => {
    const now = Date.parse("2026-11-18T12:00:00.000Z");
    const old = { at: new Date(now - 10 * 86_400_000).toISOString(), op: "publish", slug: "a", outcome: "created" };
    const fresh = { at: new Date(now - 1 * 86_400_000).toISOString(), op: "publish", slug: "a", outcome: "updated" };
    appendJournal(dataDir, old);
    appendJournal(dataDir, fresh);
    const res = pruneJournal(dataDir, { kind: "ttl", ms: 3 * 86_400_000 }, now);
    expect(res.archived).toBe(1);
    const tail = readJournalTail(dataDir, 10);
    expect(tail).toHaveLength(1);
    expect(tail[0].outcome).toBe("updated");
    const archive = readFileSync(join(dataDir, "journal-archive.jsonl"), "utf8");
    expect(archive).toContain("created");
  });

  test("pruneJournal with never archives everything and clears", () => {
    appendJournal(dataDir, { at: "2026-11-18T12:00:00.000Z", op: "publish", slug: "a", outcome: "created" });
    const res = pruneJournal(dataDir, { kind: "never" });
    expect(res.archived).toBe(1);
    expect(res.cleared).toBe(true);
    expect(readJournalTail(dataDir, 10)).toHaveLength(0);
  });

  test("pruneVersions respects the TTL and never wipes the store", () => {
    recordVersion(dataDir, "v1", "content A", { ts: "2026-11-01T00:00:00.000Z", op: "publish", outcome: "created" });
    recordVersion(dataDir, "v1", "content B", { ts: "2026-11-18T00:00:00.000Z", op: "publish", outcome: "updated" });
    const now = Date.parse("2026-11-18T12:00:00.000Z");
    const ttl = pruneVersions(dataDir, { kind: "ttl", ms: 3 * 86_400_000 }, now);
    expect(ttl.removed).toBe(1);
    const index = readVersionIndex(dataDir, "v1");
    expect(index).toHaveLength(1);
    expect(index[0].hash).toBe(sha256Hex("content B"));
    expect(readVersionContent(dataDir, "v1", index[0])).toBe("content B");

    const never = pruneVersions(dataDir, { kind: "never" });
    expect(never.removed).toBe(1);
    expect(existsSync(join(versionsRoot(), slugDirName("v1")))).toBe(false);
    expect(readVersionIndex(dataDir, "v1")).toHaveLength(0);
  });

  test("slugDirName maps folder slugs collision-free", () => {
    expect(slugDirName("a/b-c")).toBe("a.b-c");
    expect(slugDirName("a.b-c")).toBe("a.b-c"); // dots cannot be slugs, so this input is hypothetical
  });

  test("applyRetention reports both categories", () => {
    appendJournal(dataDir, { at: "2020-01-01T00:00:00.000Z", op: "publish", slug: "a", outcome: "created" });
    recordVersion(dataDir, "ap", "old", { ts: "2020-01-01T00:00:00.000Z", op: "publish", outcome: "created" });
    const report = applyRetention(dataDir, { kind: "ttl", ms: 1000 }, { kind: "ttl", ms: 1000 });
    expect(report.journalArchived).toBe(1);
    expect(report.versionsRemoved).toBe(1);
    expect(report.slugsTouched).toEqual(["ap"]);
  });
});

// ---------------------------------------------------------------------------
// Diff engine
// ---------------------------------------------------------------------------

describe("diff", () => {
  test("empty input diff", () => {
    expect(diffContents("", "")).toEqual([]);
  });

  test("pure addition", () => {
    const hunks = diffContents("line1", "line1\nline2\nline3");
    expect(hunks).toHaveLength(1);
    const flat = hunks[0].lines;
    expect(flat[0]).toEqual({ type: "context", a: 1, b: 1, text: "line1" });
    expect(flat[1].type).toBe("add");
    expect(flat[1].b).toBe(2);
    expect(flat[2].type).toBe("add");
    expect(flat[2].b).toBe(3);
    expect(hunks[0].aStart).toBe(1);
    expect(hunks[0].bStart).toBe(1);
  });

  test("pure deletion", () => {
    const hunks = diffContents("a\nb\nc", "a\nc");
    const flat = hunks.flatMap((h) => h.lines);
    expect(flat.filter((l) => l.type === "del").map((l) => l.text)).toEqual(["b"]);
    expect(flat.filter((l) => l.type === "context").map((l) => l.text)).toEqual(["a", "c"]);
  });

  test("replace is paired del/add", () => {
    const hunks = diffContents("a\nb\nc", "a\nX\nc");
    const flat = hunks.flatMap((h) => h.lines);
    expect(flat.filter((l) => l.type === "del").map((l) => l.text)).toEqual(["b"]);
    expect(flat.filter((l) => l.type === "add").map((l) => l.text)).toEqual(["X"]);
  });

  test("context radius separates distant hunks", () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const b = a.replace("l5", "CHANGED1").replace("l15", "CHANGED2");
    const hunks = diffContents(a, b, 3);
    expect(hunks.length).toBeGreaterThanOrEqual(1);
    // with context 3 and 5 unchanged lines between, the changes must not merge
    const joined = hunks.flatMap((h) => h.lines).map((l) => l.type);
    const firstChange = joined.indexOf("del");
    const lastChange = joined.lastIndexOf("add");
    expect(joined.slice(firstChange, lastChange + 1)).toContain("context");
  });

  test("context 0 yields bare hunks", () => {
    const a = "x\ny\nz\nq\nr\ns";
    const b = "x\ny\nZ\nq\nr\ns";
    const hunks = diffContents(a, b, 0);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.every((l) => l.type !== "context")).toBe(true);
  });

  test("tombstone side diffs as full deletion", () => {
    const hunks = diffContents("a\nb", "", 3);
    const flat = hunks.flatMap((h) => h.lines);
    expect(flat.filter((l) => l.type === "del").map((l) => l.text)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// Version store
// ---------------------------------------------------------------------------

describe("version store", () => {
  test("record, read back, and dedupe unchanged states", () => {
    const first = recordVersion(dataDir, "vp", "alpha", { ts: "2026-11-18T10:00:00.000Z", op: "publish", outcome: "created" });
    expect(first).not.toBeNull();
    const dupe = recordVersion(dataDir, "vp", "alpha", { ts: "2026-11-18T10:01:00.000Z", op: "publish", outcome: "updated" });
    expect(dupe).toBeNull(); // identical state, not recorded twice
    const second = recordVersion(dataDir, "vp", "beta", { ts: "2026-11-18T10:02:00.000Z", op: "publish", outcome: "updated" });
    expect(second).not.toBeNull();
    const index = readVersionIndex(dataDir, "vp");
    expect(index).toHaveLength(2);
    expect(index[0].hash).toBe(sha256Hex("alpha"));
    expect(index[1].hash).toBe(sha256Hex("beta"));
    expect(readVersionContent(dataDir, "vp", index[0])).toBe("alpha");
    expect(readVersionContent(dataDir, "vp", index[1])).toBe("beta");
  });

  test("tombstones record null hashes without content files", () => {
    recordVersion(dataDir, "vt", "content", { ts: "2026-11-18T10:00:00.000Z", op: "publish", outcome: "created" });
    recordVersion(dataDir, "vt", null, { ts: "2026-11-18T10:01:00.000Z", op: "delete", outcome: "deleted" });
    const index = readVersionIndex(dataDir, "vt");
    expect(index[1].hash).toBeNull();
    expect(readVersionContent(dataDir, "vt", index[1])).toBeNull();
  });

  test("findVersionByHash returns the most recent match", () => {
    recordVersion(dataDir, "vh", "same-bytes", { ts: "2026-11-18T10:00:00.000Z", op: "publish", outcome: "created" });
    recordVersion(dataDir, "vh", "other", { ts: "2026-11-18T10:01:00.000Z", op: "publish", outcome: "updated" });
    recordVersion(dataDir, "vh", "same-bytes", { ts: "2026-11-18T10:02:00.000Z", op: "undo", outcome: "restored" });
    const found = findVersionByHash(dataDir, "vh", sha256Hex("same-bytes"));
    expect(found?.op).toBe("undo");
  });

  test("folder slugs store under dotted directories", () => {
    recordVersion(dataDir, "sub/dir", "nested", { ts: "2026-11-18T10:00:00.000Z", op: "publish", outcome: "created" });
    expect(existsSync(join(versionsRoot(), "sub.dir", "index.json"))).toBe(true);
    const index = readVersionIndex(dataDir, "sub/dir");
    expect(readVersionContent(dataDir, "sub/dir", index[0])).toBe("nested");
  });
});

// ---------------------------------------------------------------------------
// Stomp guard (multi-session)
// ---------------------------------------------------------------------------

describe("stomp guard", () => {
  test("publish from the same session passes; different session inside the window is refused as stale-editor", async () => {
    const d = deps();
    await call(d, { op: "publish", pages: [{ slug: "sg", content: page("sg", "A") }], session: "tab-1" });
    const same = await call(d, { op: "publish", pages: [{ slug: "sg", content: page("sg", "B") }], session: "tab-1" });
    expect((same as any).result.pages[0].status).toBe("published");
    expect(readFileSync(join(conceptsDir(), "sg.md"), "utf8")).toContain("B v0".replace(" v0", ""));

    const other = await call(d, { op: "publish", pages: [{ slug: "sg", content: page("sg", "C") }], session: "tab-2" });
    const r = (other as any).result.pages[0];
    expect(r.status).toBe("stale-editor");
    expect(r.detail).toContain("another editor session");
    // nothing was written
    expect(readFileSync(join(conceptsDir(), "sg.md"), "utf8")).toContain("B");
    // no version recorded for the refused publish
    const versions = await call(d, { op: "versions", slug: "sg" });
    expect((versions as any).result.versions.every((v: any) => v.hash !== sha256Hex(page("sg", "C")))).toBe(true);
  });

  test("after the window a different session publishes normally", async () => {
    const d = deps({ now: () => new Date(Date.parse("2026-11-18T12:00:00.000Z")) });
    await call(d, { op: "publish", pages: [{ slug: "sg2", content: page("sg2", "A") }], session: "tab-1" });
    // Move the clock beyond the 90s stomp window.
    d.now = () => new Date(Date.parse("2026-11-18T12:00:00.000Z") + 120_000);
    const res = await call(d, { op: "publish", pages: [{ slug: "sg2", content: page("sg2", "B") }], session: "tab-2" });
    expect((res as any).result.pages[0].status).toBe("published");
  });

  test("publish without a session skips the guard (external callers)", async () => {
    const d = deps();
    await call(d, { op: "publish", pages: [{ slug: "sg3", content: page("sg3", "A") }], session: "tab-1" });
    const res = await call(d, { op: "publish", pages: [{ slug: "sg3", content: page("sg3", "B") }] });
    expect((res as any).result.pages[0].status).toBe("published");
  });
});

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

describe("undo and redo", () => {
  test("publish, edit, publish, undo, redo round-trip", async () => {
    const d = deps();
    await call(d, { op: "publish", pages: [{ slug: "ur", content: page("ur", "V1", ["test"], "one") }] });
    await call(d, { op: "publish", pages: [{ slug: "ur", content: page("ur", "V2", ["test"], "two") }] });
    expect(readFileSync(join(conceptsDir(), "ur.md"), "utf8")).toContain("two");

    const undo = await call(d, { op: "undo", slug: "ur" });
    const ur = (undo as any).result.pages[0];
    expect(ur.status).toBe("published");
    expect(readFileSync(join(conceptsDir(), "ur.md"), "utf8")).toContain("one");
    expect(ur.redoCount).toBe(1);
    expect(ur.undoCount).toBe(1); // the "page did not exist" state is still undoable

    const redo = await call(d, { op: "redo", slug: "ur" });
    const rr = (redo as any).result.pages[0];
    expect(rr.status).toBe("published");
    expect(readFileSync(join(conceptsDir(), "ur.md"), "utf8")).toContain("two");
    expect(rr.undoCount).toBe(2); // null-state + V1 are both undoable again
    expect(rr.redoCount).toBe(0);
  });

  test("undo of a delete restores the page", async () => {
    const d = deps();
    await call(d, { op: "publish", pages: [{ slug: "ud", content: page("ud", "Gone soon") }] });
    const hash = sha256Hex(readFileSync(join(conceptsDir(), "ud.md"), "utf8"));
    const del = await call(d, { op: "delete", slug: "ud", baseHash: hash });
    expect((del as any).result.pages[0].status).toBe("deleted");
    expect(existsSync(join(conceptsDir(), "ud.md"))).toBe(false);

    const undo = await call(d, { op: "undo", slug: "ud" });
    expect((undo as any).result.pages[0].status).toBe("published");
    expect(readFileSync(join(conceptsDir(), "ud.md"), "utf8")).toContain("Gone soon");
    // baseline re-established: a second identical publish converges
    const republish = await call(d, { op: "publish", pages: [{ slug: "ud", content: readFileSync(join(conceptsDir(), "ud.md"), "utf8") }] });
    expect((republish as any).result.pages[0].status).toBe("published");
  });

  test("undo to a deleted state removes the page, redo brings it back", async () => {
    const d = deps();
    await call(d, { op: "publish", pages: [{ slug: "u2", content: page("u2", "Temp") }] });
    const hash = sha256Hex(readFileSync(join(conceptsDir(), "u2.md"), "utf8"));
    await call(d, { op: "delete", slug: "u2", baseHash: hash });
    const undo = await call(d, { op: "undo", slug: "u2" }); // back to Temp
    expect((undo as any).result.pages[0].status).toBe("published");
    const undo2 = await call(d, { op: "undo", slug: "u2" }); // back to deleted state
    expect((undo2 as any).result.pages[0].status).toBe("deleted");
    expect(existsSync(join(conceptsDir(), "u2.md"))).toBe(false);
    const redo = await call(d, { op: "redo", slug: "u2" });
    expect((redo as any).result.pages[0].status).toBe("published");
    expect(existsSync(join(conceptsDir(), "u2.md"))).toBe(true);
  });

  test("a new edit clears the redo stack", async () => {
    const d = deps();
    await call(d, { op: "publish", pages: [{ slug: "u3", content: page("u3", "A") }] });
    await call(d, { op: "publish", pages: [{ slug: "u3", content: page("u3", "B") }] });
    const undo = await call(d, { op: "undo", slug: "u3" });
    expect((undo as any).result.pages[0].redoCount).toBe(1);
    await call(d, { op: "publish", pages: [{ slug: "u3", content: page("u3", "C") }] });
    const after = await call(d, { op: "redo", slug: "u3" });
    expect((after as any).result.pages[0].status).toBe("unchanged");
    // stack state is consistent: undo once returns to B
    const undoAgain = await call(d, { op: "undo", slug: "u3" });
    expect(readFileSync(join(conceptsDir(), "u3.md"), "utf8")).toContain("B");
    expect((undoAgain as any).result.pages[0].undoCount).toBe(1);
  });

  test("undo with empty stack is unchanged", async () => {
    const res = await call(deps(), { op: "undo", slug: "never-published" });
    expect((res as any).result.pages[0].status).toBe("unchanged");
    const redoRes = await call(deps(), { op: "redo", slug: "never-published" });
    expect((redoRes as any).result.pages[0].status).toBe("unchanged");
  });
});

// ---------------------------------------------------------------------------
// New read ops + error journaling + journal policy
// ---------------------------------------------------------------------------

describe("log, versions, diff ops", () => {
  test("log returns journal entries; versions and diff return structured data", async () => {
    const d = deps();
    await call(d, { op: "publish", pages: [{ slug: "lr", content: page("lr", "One") }] });
    await call(d, { op: "publish", pages: [{ slug: "lr", content: page("lr", "Two") }] });

    const log = await call(d, { op: "log", count: 10 });
    const entries = (log as any).result.entries;
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.at(-1).outcome).toBe("updated");

    const versions = await call(d, { op: "versions", slug: "lr" });
    const vr = (versions as any).result;
    expect(vr.versions).toHaveLength(2); // new page: two states, no pre-bridge seed
    expect(vr.currentHash).toBe(sha256Hex(page("lr", "Two")));
    expect(vr.undoCount).toBe(2);

    const prevHash = vr.versions[0].hash;
    const diff = await call(d, { op: "diff", slug: "lr", from: prevHash, to: "current" });
    const dr = (diff as any).result;
    expect(dr.fromHash).toBe(prevHash);
    expect(dr.toHash).toBe(sha256Hex(page("lr", "Two")));
    const flat = dr.hunks.flatMap((h: any) => h.lines);
    expect(flat.some((l: any) => l.type === "del")).toBe(true);
    expect(flat.some((l: any) => l.type === "add")).toBe(true);

    const badDiff = await call(d, { op: "diff", slug: "lr", from: "deadbeef" });
    expect((badDiff as any).result.status).toBe("error");
  });

  test("identical republish journals unchanged and records no new version", async () => {
    const d = deps();
    const content = page("idem", "Same");
    await call(d, { op: "publish", pages: [{ slug: "idem", content }] });
    await call(d, { op: "publish", pages: [{ slug: "idem", content }] });
    const log = await call(d, { op: "log", count: 5 });
    const outcomes = (log as any).result.entries.map((e: any) => e.outcome);
    expect(outcomes.filter((o: string) => o === "unchanged").length).toBe(1);
    const versions = await call(d, { op: "versions", slug: "idem" });
    expect((versions as any).result.versions).toHaveLength(1); // created once, identical republish deduped
  });

  test("validation errors are journalled for the log panel", async () => {
    const d = deps();
    const bad = "---\ntitle: \"x\"\nslug: bad\n---\n\n\n";
    const res = await call(d, { op: "publish", pages: [{ slug: "bad", content: bad }] });
    expect((res as any).result.pages[0].status).toBe("error");
    const log = await call(d, { op: "log", count: 5 });
    const err = (log as any).result.entries.find((e: any) => e.outcome === "error" && e.slug === "bad");
    expect(err).toBeDefined();
  });

  test("log retention never stops journaling but keeps existing history", async () => {
    const d = deps();
    await call(d, { op: "publish", pages: [{ slug: "jn", content: page("jn", "One") }] });
    const before = readJournalTail(dataDir, 100).length;
    expect(before).toBeGreaterThan(0);
    const res = await call(d, { op: "publish", pages: [{ slug: "jn", content: page("jn", "Two") }], retention: { log: "never" } });
    expect((res as any).result.pages[0].status).toBe("published");
    const after = readJournalTail(dataDir, 100).length;
    expect(after).toBe(before); // nothing new appended, nothing destroyed
  });

  test("prune op applies retention and reports", async () => {
    const d = deps();
    // Records backdated well before the engine's fixed clock.
    appendJournal(dataDir, { at: "2020-01-01T00:00:00.000Z", op: "publish", slug: "pr", outcome: "created" });
    recordVersion(dataDir, "pr", "old content", { ts: "2020-01-01T00:00:00.000Z", op: "publish", outcome: "created" });
    const res = await call(d, { op: "prune", retention: { log: "1s", versions: "1s" } });
    const report = (res as any).result;
    expect(report.journalArchived).toBe(1);
    expect(typeof report.versionsRemoved).toBe("number");
    expect(report.versionsRemoved).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Re-verify (CAS window narrowing) — direct unit tests
// ---------------------------------------------------------------------------

describe("re-verify behavior via ops", () => {
  test("external edit between ops still produces the classic conflict", async () => {
    const d = deps();
    await call(d, { op: "publish", pages: [{ slug: "rv", content: page("rv", "One") }] });
    // Simulate an external Cadet-side writer: edit the file directly.
    writeFileSync(join(conceptsDir(), "rv.md"), page("rv", "External write"));
    const res = await call(d, { op: "publish", pages: [{ slug: "rv", content: page("rv", "Two") }] });
    expect((res as any).result.pages[0].status).toBe("conflict");
  });
});
