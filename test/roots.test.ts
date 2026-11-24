/**
 * Tests for workspace-root page mapping (NOW/SOUL/IDENTITY/HEARTBEAT).
 * Run with: bun test
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleOp, type BridgeDeps, type BridgeResponse } from "../src/ops.ts";
import { listBridgePages, readBridgePage } from "../src/store.ts";
import { validatePageContent } from "../src/frontmatter.ts";

const ROOTS: string[] = [];
let workspace = "";
let dataDir = "";

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
    now: () => new Date("2026-11-24T12:00:00.000Z"),
    ...overrides,
  };
}

async function call(d: BridgeDeps, payload: Record<string, unknown>): Promise<BridgeResponse> {
  return handleOp(d, payload);
}

beforeEach(() => {
  const root = join(tmpdir(), `mikiedi-roots-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  ROOTS.push(root);
  workspace = root;
  dataDir = join(root, "plugin-data");
  mkdirSync(join(workspace, "memory", "concepts"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
});

afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

describe("root workspace files as bridge pages", () => {
  test("fetchAll exposes NOW.md as slug 'now' with plain-markdown content", async () => {
    writeFileSync(join(workspace, "NOW.md"), "# NOW\n\n- item one\n");
    const res = await call(deps(), { op: "fetchAll" });
    expect(res.ok).toBe(true);
    const pages = (res.result as { pages: Array<{ slug: string; content: string }> }).pages;
    const now = pages.find((p) => p.slug === "now");
    expect(now).toBeDefined();
    expect(now!.content).toContain("# NOW");
  });

  test("publish writes the workspace-root file without frontmatter", async () => {
    writeFileSync(join(workspace, "SOUL.md"), "# SOUL\n\nold body\n");
    // Establish the baseline first so the CAS check has something to match.
    await call(deps(), { op: "adopt", slugs: ["soul"] });
    const res = await call(deps(), {
      op: "publish",
      pages: [{ slug: "soul", content: "# SOUL\n\nnew body\n" }],
    });
    expect(res.ok).toBe(true);
    const out = (res.result as { pages: Array<{ slug: string; status: string; issues?: string[] }> }).pages[0];
    expect(out.status).toBe("published");
    expect(readFileSync(join(workspace, "SOUL.md"), "utf8")).toContain("new body");
    // The concept store must NOT receive a copy of the root page.
    expect(existsSync(join(workspace, "memory", "concepts", "soul.md"))).toBe(false);
  });

  test("validate op accepts plain markdown for root slugs and rejects empties", async () => {
    const res = await call(deps(), {
      op: "validate",
      pages: [
        { slug: "identity", content: "# IDENTITY\n\nI am Vellum.\n" },
        { slug: "heartbeat", content: "" },
      ],
    });
    const pages = (res.result as { pages: Array<{ slug: string; status: string }> }).pages;
    expect(pages[0].status).toBe("published");
    expect(pages[1].status).toBe("error");
  });

  test("delete of a root slug is refused and leaves the file untouched", async () => {
    const body = "# NOW\n\nprecious\n";
    writeFileSync(join(workspace, "NOW.md"), body);
    await call(deps(), { op: "adopt", slugs: ["now"] });
    const hash = (await call(deps(), { op: "page", slug: "now" })).result as { hash: string };
    const res = await call(deps(), { op: "delete", slugs: [{ slug: "now", hash: hash.hash }] });
    const out = (res.result as { pages: Array<{ slug: string; status: string; issues?: string[] }> }).pages[0];
    expect(out.status).toBe("error");
    expect(readFileSync(join(workspace, "NOW.md"), "utf8")).toContain("precious");
  });

  test("listBridgePages merges root files with the corpus and skips absent files", () => {
    writeFileSync(join(workspace, "NOW.md"), "# NOW\n");
    writeFileSync(join(workspace, "memory", "concepts", "alpha.md"), "---\ntitle: Alpha\n---\n\nBody.\n");
    const slugs = listBridgePages(workspace, join(workspace, "memory", "concepts")).map((p) => p.slug);
    expect(slugs).toContain("now");
    expect(slugs).toContain("alpha");
    expect(slugs).not.toContain("soul"); // SOUL.md was not written
    expect(slugs).not.toContain("heartbeat");
  });

  test("readBridgePage falls through to the concept store for normal slugs", () => {
    writeFileSync(join(workspace, "memory", "concepts", "one.md"), "---\ntitle: One\n---\n\nOne body.\n");
    expect(readBridgePage(workspace, join(workspace, "memory", "concepts"), "one")).toContain("One body.");
    expect(readBridgePage(workspace, join(workspace, "memory", "concepts"), "now")).toBe(null);
  });

  test("validatePageContent keeps concept-page rules for non-root slugs", () => {
    expect(validatePageContent("no frontmatter here", "some-page").issues.length).toBeGreaterThan(0);
    expect(validatePageContent("# NOW\n\nbody\n", "now").issues.length).toBe(0);
  });

  test("empty workspaceDir disables root mapping entirely", async () => {
    writeFileSync(join(workspace, "NOW.md"), "# NOW\n");
    const d = deps({ workspaceDir: "" });
    const res = await call(d, { op: "fetchAll" });
    const pages = (res.result as { pages: Array<{ slug: string }> }).pages;
    expect(pages.find((p) => p.slug === "now")).toBeUndefined();
  });
});
