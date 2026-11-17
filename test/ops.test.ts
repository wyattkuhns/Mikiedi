/**
 * Unit tests for the Mikiedi bridge operation engine.
 * Run with: bun test
 *
 * Tests exercise real filesystem behavior against temporary directories;
 * no Cadet runtime is needed and live memory is never touched.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleOp, type BridgeDeps, type BridgeResponse } from "../src/ops.ts";
import { sha256Hex } from "../src/revision.ts";
import { validatePageContent, splitFrontmatter, parseFrontmatter } from "../src/frontmatter.ts";
import { validateSlug } from "../src/slugs.ts";

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
    now: () => new Date("2026-11-16T12:00:00.000Z"),
    ...overrides,
  };
}

function call(deps: BridgeDeps, payload: Record<string, unknown>): Promise<BridgeResponse> {
  return handleOp(deps, payload);
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

// ---------------------------------------------------------------------------
// Slug rules
// ---------------------------------------------------------------------------

describe("slug validation", () => {
  test("accepts plain and nested slugs", () => {
    expect(validateSlug("wyatt")).toBeNull();
    expect(validateSlug("people/wyatt-kuhns")).toBeNull();
    expect(validateSlug("a".repeat(80))).toBeNull();
  });

  test("rejects Cadet rule violations", () => {
    expect(validateSlug("")).toMatch(/non-empty/);
    expect(validateSlug("Wyatt")).toMatch(/lowercase/);
    expect(validateSlug("has space")).toMatch(/lowercase/);
    expect(validateSlug("has_underscore")).toMatch(/lowercase/);
    expect(validateSlug("/leading")).toMatch(/slash/);
    expect(validateSlug("trailing/")).toMatch(/slash/);
    expect(validateSlug("a//b")).toMatch(/empty segments/);
    expect(validateSlug("..")).toMatch(/\.\./);
    expect(validateSlug("a/../b")).toMatch(/\.\./);
    expect(validateSlug("a".repeat(81))).toMatch(/80 characters/);
    expect(validateSlug(`${"a".repeat(50)}/${"b".repeat(151)}`)).toMatch(/200 characters/);
  });
});

// ---------------------------------------------------------------------------
// Frontmatter validation
// ---------------------------------------------------------------------------

describe("frontmatter validation", () => {
  test("accepts corpus-style pages", () => {
    const v = validatePageContent(page("wyatt", "Wyatt Kuhns"), "wyatt");
    expect(v.issues).toEqual([]);
    expect(v.frontmatter!.title).toBe("Wyatt Kuhns");
    expect(v.frontmatter!.tags).toEqual(["test"]);
    expect(v.frontmatter!.links).toEqual(["other-page — a related page"]);
  });

  test("rejects zero-byte and frontmatter-only pages", () => {
    expect(validatePageContent("", "x").issues.length).toBeGreaterThan(0);
    const fmOnly = "---\ntitle: x\n---\n";
    expect(validatePageContent(fmOnly, "x").issues.join(" ")).toMatch(/body is empty/);
  });

  test("rejects unquoted colon values and duplicate keys", () => {
    const bad = '---\ntitle: Some: Title\n---\nbody\n';
    expect(validatePageContent(bad, "x").issues.join(" ")).toMatch(/": "/);
    const dup = '---\ntitle: a\ntitle: b\n---\nbody\n';
    expect(validatePageContent(dup, "x").issues.join(" ")).toMatch(/duplicate key/);
  });

  test("rejects string tags and slug mismatch", () => {
    const strTags = '---\ntags: memory, test\n---\nbody\n';
    expect(validatePageContent(strTags, "x").issues.join(" ")).toMatch(/must be a YAML list/);
    expect(validatePageContent(page("wyatt", "T"), "other").issues.join(" ")).toMatch(/does not match/);
  });

  test("rejects missing frontmatter block and tabs", () => {
    expect(validatePageContent("# Just a page", "x").issues.join(" ")).toMatch(/frontmatter/);
    const tabbed = "---\ntitle:\tx\n---\nbody\n";
    expect(validatePageContent(tabbed, "x").issues.join(" ")).toMatch(/tab/);
  });

  test("warns when the slug key is absent", () => {
    const noSlug = '---\ntitle: "Test"\n---\nBody.\n';
    const v = validatePageContent(noSlug, "test");
    expect(v.issues).toEqual([]);
    expect(v.warnings.join(" ")).toMatch(/no slug key/);
  });

  test("splitFrontmatter handles bodies containing --- lines", () => {
    const content = "---\ntitle: x\n---\nbody\n---\nmore\n";
    const s = splitFrontmatter(content);
    expect(s.body).toContain("more");
  });
});

// ---------------------------------------------------------------------------
// Publish flow
// ---------------------------------------------------------------------------

describe("publish flow", () => {
  test("publishes a new page, records baseline, writes journal", async () => {
    const res = await call(deps(), { op: "publish", pages: [{ slug: "new-page", content: page("new-page", "New") }] });
    expect(res.ok).toBe(true);
    const result = (res as any).result;
    expect(result.pages[0].status).toBe("published");
    const written = readFileSync(join(conceptsDir(), "new-page.md"), "utf8");
    expect(written).toContain("title: \"New\"");
    // baseline recorded
    const status = await call(deps(), { op: "status" });
    const st = (status as any).result;
    expect(st.journalTail[st.journalTail.length - 1].op).toBe("publish");
    expect(st.journalTail[st.journalTail.length - 1].outcome).toBe("created");
  });

  test("republish of unchanged-baseline page updates cleanly", async () => {
    await call(deps(), { op: "publish", pages: [{ slug: "p1", content: page("p1", "One") }] });
    const res = await call(deps(), { op: "publish", pages: [{ slug: "p1", content: page("p1", "One v2") }] });
    expect((res as any).result.pages[0].status).toBe("published");
    expect(readFileSync(join(conceptsDir(), "p1.md"), "utf8")).toContain("One v2");
    // a pre-image snapshot exists
    const status = await call(deps(), { op: "status" });
    expect((status as any).result.journalTail.at(-1).outcome).toBe("updated");
  });

  test("fetchAll returns every page with content and hashes, read-only", async () => {
    writeFileSync(join(conceptsDir(), "one.md"), page("one", "One"));
    mkdirSync(join(conceptsDir(), "sub"), { recursive: true });
    writeFileSync(join(conceptsDir(), "sub", "two.md"), page("two", "Two"));
    const res = await call(deps(), { op: "fetchAll" });
    const pages = (res as any).result.pages;
    expect(pages.length).toBe(2);
    const one = pages.find((p: any) => p.slug === "one");
    const two = pages.find((p: any) => p.slug === "sub/two");
    expect(one.content).toContain("One");
    expect(one.hash).toBe(sha256Hex(one.content));
    expect(two.content).toContain("Two");
    expect(typeof one.mtime).toBe("string");
    // read-only: nothing written to the store, no journal entry
    expect(existsSync(join(conceptsDir(), "one.md"))).toBe(true);
    expect(existsSync(join(dataDir, "journal.jsonl"))).toBe(false);
  });

  test("existing page without baseline requires adopt", async () => {
    writeFileSync(join(conceptsDir(), "pre.md"), page("pre", "Pre-existing"));
    const res = await call(deps(), { op: "publish", pages: [{ slug: "pre", content: page("pre", "Edited") }] });
    expect((res as any).result.pages[0].status).toBe("adopt-required");
    // file untouched
    expect(readFileSync(join(conceptsDir(), "pre.md"), "utf8")).toContain("Pre-existing");
  });

  test("adopt records baseline without changing content, then publish works", async () => {
    writeFileSync(join(conceptsDir(), "pre.md"), page("pre", "Pre-existing"));
    const adopt = await call(deps(), { op: "adopt", slugs: ["pre"] });
    expect((adopt as any).result.pages[0].status).toBe("unchanged");
    const res = await call(deps(), { op: "publish", pages: [{ slug: "pre", content: page("pre", "Edited") }] });
    expect((res as any).result.pages[0].status).toBe("published");
  });

  test("external edit between publish and republish produces a conflict", async () => {
    await call(deps(), { op: "publish", pages: [{ slug: "p2", content: page("p2", "V1") }] });
    // Simulate another writer (consolidation, or the assistant) editing the page.
    const external = page("p2", "Externally edited").replace("Body text.", "External body.");
    writeFileSync(join(conceptsDir(), "p2.md"), external);
    const res = await call(deps(), { op: "publish", pages: [{ slug: "p2", content: page("p2", "V2") }] });
    const r = (res as any).result.pages[0];
    expect(r.status).toBe("conflict");
    expect(r.cadetContent).toContain("External body.");
    // conflict artifact preserves both versions
    expect(existsSync(join(r.artifactDir, "silverbullet.md"))).toBe(true);
    expect(existsSync(join(r.artifactDir, "cadet.md"))).toBe(true);
    expect(readFileSync(join(r.artifactDir, "cadet.md"), "utf8")).toContain("External body.");
    // canonical file untouched
    expect(readFileSync(join(conceptsDir(), "p2.md"), "utf8")).toContain("External body.");
    // status reports the conflict
    const status = await call(deps(), { op: "status" });
    expect((status as any).result.conflicts.map((c: any) => c.slug)).toEqual(["p2"]);
  });

  test("stale baseHash alone produces a conflict", async () => {
    await call(deps(), { op: "publish", pages: [{ slug: "p3", content: page("p3", "V1") }] });
    const res = await call(deps(), {
      op: "publish",
      pages: [{ slug: "p3", content: page("p3", "V2"), baseHash: sha256Hex("stale") }],
    });
    expect((res as any).result.pages[0].status).toBe("conflict");
  });

  test("resolve keep-cadet then refresh-verdict flows", async () => {
    await call(deps(), { op: "publish", pages: [{ slug: "p4", content: page("p4", "V1") }] });
    writeFileSync(join(conceptsDir(), "p4.md"), page("p4", "External").replace("Body text.", "External body."));
    await call(deps(), { op: "publish", pages: [{ slug: "p4", content: page("p4", "V2") }] });
    const res = await call(deps(), { op: "resolve", slug: "p4", action: "keep-cadet" });
    expect((res as any).result.pages[0].status).toBe("resolved");
    const status = await call(deps(), { op: "status" });
    expect((status as any).result.conflicts).toEqual([]);
    // editor copy is now stale relative to the new baseline: sync says update
    const sync = await call(deps(), { op: "sync", slug: "p4", content: page("p4", "V2") });
    expect((sync as any).result.action).toBe("update");
    expect((sync as any).result.cadetContent).toContain("External body.");
    // a stale republish must NOT override the kept resolution
    const republish = await call(deps(), { op: "publish", pages: [{ slug: "p4", content: page("p4", "V2") }] });
    expect((republish as any).result.pages[0].status).toBe("error");
    expect(readFileSync(join(conceptsDir(), "p4.md"), "utf8")).toContain("External body.");
    // after the editor catches up, the marker clears and publishing works again
    const canonicalNow = readFileSync(join(conceptsDir(), "p4.md"), "utf8");
    const caughtUp = await call(deps(), { op: "sync", slug: "p4", content: canonicalNow });
    expect((caughtUp as any).result.action).toBe("current");
    const fresh = await call(deps(), { op: "publish", pages: [{ slug: "p4", content: page("p4", "V3") }] });
    expect((fresh as any).result.pages[0].status).toBe("published");
  });

  test("resolve publish-sb writes the editor version explicitly", async () => {
    await call(deps(), { op: "publish", pages: [{ slug: "p5", content: page("p5", "V1") }] });
    writeFileSync(join(conceptsDir(), "p5.md"), page("p5", "External").replace("Body text.", "External body."));
    await call(deps(), { op: "publish", pages: [{ slug: "p5", content: page("p5", "V2") }] });
    const res = await call(deps(), { op: "resolve", slug: "p5", action: "publish-sb", content: page("p5", "V2-resolved") });
    expect((res as any).result.pages[0].status).toBe("resolved");
    expect(readFileSync(join(conceptsDir(), "p5.md"), "utf8")).toContain("V2-resolved");
  });
});

// ---------------------------------------------------------------------------
// Delete, sync, refresh
// ---------------------------------------------------------------------------

describe("delete and sync", () => {
  test("delete requires exact CAS hash and tombstones the page", async () => {
    await call(deps(), { op: "publish", pages: [{ slug: "d1", content: page("d1", "Gone soon") }] });
    const noCas = await call(deps(), { op: "delete", slug: "d1" });
    expect((noCas as any).result.pages[0].status).toBe("conflict");
    const pageResp = await call(deps(), { op: "page", slug: "d1" });
    const hash = (pageResp as any).result.hash;
    const res = await call(deps(), { op: "delete", slug: "d1", baseHash: hash });
    expect((res as any).result.pages[0].status).toBe("deleted");
    expect(existsSync(join(conceptsDir(), "d1.md"))).toBe(false);
    const sync = await call(deps(), { op: "sync", slug: "d1" });
    expect((sync as any).result.action).toBe("deleted-in-cadet");
  });

  test("sync reports current / update / publish-from-editor correctly", async () => {
    await call(deps(), { op: "publish", pages: [{ slug: "s1", content: page("s1", "V1") }] });
    const current = await call(deps(), { op: "sync", slug: "s1", content: page("s1", "V1") });
    expect((current as any).result.action).toBe("current");
    const edited = await call(deps(), { op: "sync", slug: "s1", content: page("s1", "V2 draft") });
    expect((edited as any).result.action).toBe("publish-from-editor");
    // external edit, editor copy unchanged → update
    writeFileSync(join(conceptsDir(), "s1.md"), page("s1", "External").replace("Body text.", "External body."));
    const update = await call(deps(), { op: "sync", slug: "s1", content: page("s1", "V1") });
    expect((update as any).result.action).toBe("update");
    expect((update as any).result.cadetContent).toContain("External body.");
  });

  test("sync records conflict when both sides diverge", async () => {
    await call(deps(), { op: "publish", pages: [{ slug: "s2", content: page("s2", "V1") }] });
    writeFileSync(join(conceptsDir(), "s2.md"), page("s2", "External").replace("Body text.", "External body."));
    const res = await call(deps(), { op: "sync", slug: "s2", content: page("s2", "V2 draft") });
    expect((res as any).result.action).toBe("conflict");
    expect((res as any).result.cadetContent).toContain("External body.");
  });
});

describe("refresh reporting", () => {
  test("failed refresh leaves publication valid and marks pendingRefresh", async () => {
    const d = deps({ refresh: async () => ({ ok: false, detail: "stubbed failure" }) });
    const res = await call(d, { op: "publish", pages: [{ slug: "r1", content: page("r1", "R") }] });
    expect((res as any).result.pages[0].status).toBe("published");
    expect((res as any).result.refresh.ok).toBe(false);
    const status = await call(d, { op: "status" });
    expect((status as any).result.pendingRefresh).toBe(true);
  });

  test("refresh op can clear pendingRefresh", async () => {
    const d = deps({ refresh: async () => ({ ok: false, detail: "stubbed failure" }) });
    await call(d, { op: "publish", pages: [{ slug: "r2", content: page("r2", "R") }] });
    const d2 = deps({ refresh: async () => ({ ok: true, detail: "stubbed success" }) });
    const res = await call(d2, { op: "refresh" });
    expect((res as any).result.ok).toBe(true);
    const status = await call(d2, { op: "status" });
    expect((status as any).result.pendingRefresh).toBe(false);
  });
});

describe("validation op and error handling", () => {
  test("validate reports issues without writing", async () => {
    const res = await call(deps(), {
      op: "validate",
      pages: [{ slug: "Bad Slug", content: page("Bad Slug", "T") }],
    });
    expect((res as any).result.pages[0].status).toBe("error");
    expect(existsSync(join(conceptsDir(), "Bad Slug.md"))).toBe(false);
  });

  test("unknown op returns a helpful error", async () => {
    const res = await call(deps(), { op: "frobnicate" });
    expect(res.ok).toBe(false);
    expect((res as any).error).toMatch(/unknown op/);
  });

  test("adopt all records baselines for every existing page", async () => {
    writeFileSync(join(conceptsDir(), "a1.md"), page("a1", "A1"));
    writeFileSync(join(conceptsDir(), "a2.md"), page("a2", "A2"));
    const res = await call(deps(), { op: "adopt", slugs: "all" });
    const statuses = (res as any).result.pages.map((p: any) => p.status);
    expect(statuses).toEqual(["unchanged", "unchanged"]);
  });
});
