/**
 * Mikiedi operation engine.
 *
 * All bridge behavior lives here, decoupled from the HTTP route so it is
 * unit-testable. Every operation follows the conflict model:
 *
 *  - The canonical store is the authority; SilverBullet holds an editable
 *    copy, never a live mount.
 *  - A publish is accepted only when the canonical page still matches the
 *    bridge's recorded baseline (full-byte SHA-256). Otherwise both versions
 *    are preserved verbatim as a conflict artifact and nothing is written.
 *  - A page that exists in Cadet but has no bridge baseline requires an
 *    explicit `adopt` operation first: adoption never overwrites anything,
 *    it only records "what the editor last saw".
 *  - Every destructive or replacing operation snapshots the pre-image into
 *    the plugin data directory and appends a journal entry.
 *  - Publication is atomic per page (temp file + rename). Concurrent ops are
 *    serialized by an in-process mutex; races against other Cadet writers
 *    are narrowed by the CAS check and are a documented v0.1 limitation.
 */
import { readFileSync, unlinkSync } from "node:fs";
import { loadConfig, type ResolvedConfig } from "./config.ts";
import { validatePageContent } from "./frontmatter.ts";
import { appendJournal, readJournalTail, type JournalEntry } from "./journal.ts";
import { sha256Hex, shortHash } from "./revision.ts";
import { runRebuildIndex, type RefreshResult } from "./refresh.ts";
import { validateSlug, pagePath } from "./slugs.ts";
import { loadState, saveState, ensureDataDir, emptyState, type BridgeState } from "./state.ts";
import { readTextOrNull, writePageAtomic, snapshotPage, writeConflictArtifact, listConceptPages } from "./store.ts";

export interface BridgeDeps {
  config: ResolvedConfig;
  /** Plugin data directory (state, journal, snapshots, conflicts). */
  dataDir: string;
  workspaceDir: string;
  refresh?: () => Promise<RefreshResult>;
  now?: () => Date;
}

export interface StagedPage {
  slug: string;
  content: string;
  /** Full-byte hash of the canonical page this edit was based on, when known. */
  baseHash?: string;
}

export interface PageOpResult {
  slug: string;
  status: "published" | "conflict" | "adopt-required" | "deleted" | "resolved" | "unchanged" | "missing" | "error";
  issues?: string[];
  warnings?: string[];
  cadetHash?: string | null;
  sbHash?: string;
  artifactDir?: string;
  cadetContent?: string;
  detail?: string;
}

export interface StatusReport {
  plugin: string;
  version: string;
  conceptsDir: string;
  conceptsDirIsDefault: boolean;
  pageCount: number;
  conflicts: Array<{ slug: string; at: string; artifactDir: string }>;
  pendingRefresh: boolean;
  lastRefresh: BridgeState["lastRefresh"];
  journalTail: JournalEntry[];
}

export type SyncVerdict =
  | { action: "current" }
  | { action: "update"; cadetContent: string; cadetHash: string }
  | { action: "publish-from-editor"; detail: string }
  | { action: "deleted-in-cadet"; detail: string }
  | { action: "conflict"; cadetContent: string; cadetHash: string; artifactDir: string; detail: string };

export type BridgeResponse =
  | { ok: true; op: string; result: unknown }
  | { ok: false; error: string };

/** Serialized execution: one route host serves ops; keep them ordered. */
let mutex: Promise<unknown> = Promise.resolve();
function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutex.then(fn, fn);
  mutex = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const PLUGIN_VERSION = "0.1.0";

function iso(deps: BridgeDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

function slugError(slug: unknown): PageOpResult | null {
  const problem = validateSlug(slug);
  if (problem) return { slug: String(slug), status: "error", issues: [problem] };
  return null;
}

function validated(deps: BridgeDeps, slug: string, content: string): PageOpResult | null {
  const v = validatePageContent(content, slug);
  if (v.issues.length > 0) return { slug, status: "error", issues: v.issues, warnings: v.warnings };
  return null;
}

async function doRefresh(deps: BridgeDeps, state: BridgeState): Promise<RefreshResult> {
  const result = deps.refresh
    ? await deps.refresh()
    : await runRebuildIndex({
        cliPath: deps.config.cliPath,
        workspaceDir: deps.workspaceDir,
        timeoutMs: deps.config.refreshTimeoutMs,
      });
  state.lastRefresh = { at: iso(deps), ok: result.ok, detail: result.detail };
  state.pendingRefresh = !result.ok;
  return result;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function publishOne(
  deps: BridgeDeps,
  state: BridgeState,
  page: StagedPage,
  note: string | undefined,
): Promise<PageOpResult> {
  const slugErr = slugError(page.slug);
  if (slugErr) return slugErr;
  const slug = page.slug as string;
  const content = typeof page.content === "string" ? page.content : "";
  const contentErr = validated(deps, slug, content);
  if (contentErr) return contentErr;

  const now = iso(deps);
  const canonical = readTextOrNull(pagePath(deps.config.conceptsDir, slug));
  const canonicalHash = canonical === null ? null : sha256Hex(canonical);
  const baseline = state.baselines[slug];
  const conflict = state.conflicts[slug];
  const sbHash = sha256Hex(content);

  if (conflict) {
    return {
      slug,
      status: "conflict",
      cadetHash: canonicalHash,
      sbHash,
      artifactDir: conflict.artifactDir,
      detail:
        "An unresolved conflict is already recorded for this page. Resolve it explicitly (op 'resolve') before publishing.",
    };
  }

  if (canonicalHash !== null) {
    if (!baseline) {
      return {
        slug,
        status: "adopt-required",
        cadetHash: canonicalHash,
        detail:
          "This page exists in Cadet memory but the bridge has no baseline for it. " +
          "Run the 'adopt' op (SilverBullet: Mikiedi: Adopt Cadet state) to record what the editor last saw.",
      };
    }
    const kept = state.resolvedKeep[slug];
    if (kept && sbHash !== canonicalHash) {
      return {
        slug,
        status: "error",
        issues: [
          `Cadet's version of this page was kept by an explicit conflict resolution at ${kept.at}. ` +
            "Refresh your copy from Cadet (Mikiedi: Refresh from Cadet) before publishing; republishing the stale copy would override that resolution.",
        ],
      };
    }
    const stale =
      canonicalHash !== baseline.hash || (page.baseHash !== undefined && page.baseHash !== canonicalHash);
    if (stale) {
      const artifact = writeConflictArtifact(
        deps.dataDir,
        slug,
        { sb: content, cadet: canonical! },
        { sbHash, cadetHash: canonicalHash, baselineHash: baseline.hash, note: note ?? null },
        now,
      );
      state.conflicts[slug] = {
        at: now,
        sbHash,
        cadetHash: canonicalHash,
        artifactDir: artifact.artifactDir,
      };
      appendJournal(deps.dataDir, {
        at: now,
        op: "publish",
        slug,
        outcome: "conflict",
        prevHash: canonicalHash,
        newHash: null,
        detail: `canonical ${shortHash(canonicalHash)} != baseline ${shortHash(baseline.hash)}; both versions preserved in ${artifact.artifactDir}`,
      });
      return {
        slug,
        status: "conflict",
        cadetHash: canonicalHash,
        sbHash,
        artifactDir: artifact.artifactDir,
        cadetContent: canonical!,
        detail:
          "Cadet's copy changed since the editor's last sync. Nothing was written; both versions are preserved " +
          "(editor version and Cadet version). Resolve explicitly via op 'resolve' or Mikiedi: Refresh from Cadet.",
      };
    }
  } else if (page.baseHash !== undefined) {
    return {
      slug,
      status: "conflict",
      sbHash,
      detail:
        "The editor supplied a base revision but Cadet has no page for this slug (deleted externally?). " +
        "Refresh from Cadet, or publish with baseHash omitted to create it anew.",
    };
  }

  if (canonical !== null) {
    snapshotPage(deps.dataDir, slug, canonical, canonicalHash!, now);
  }
  writePageAtomic(deps.config.conceptsDir, slug, content);
  const newHash = sha256Hex(content);
  state.baselines[slug] = { hash: newHash, at: now };
  delete state.deleted[slug];
  // Republishing the exact canonical bytes clears a keep-cadet marker: the
  // editor demonstrably has the kept version in hand.
  if (canonicalHash !== null && newHash === canonicalHash) delete state.resolvedKeep[slug];
  if (canonicalHash === null) delete state.resolvedKeep[slug];
  appendJournal(deps.dataDir, {
    at: now,
    op: "publish",
    slug,
    outcome: canonical === null ? "created" : "updated",
    prevHash: canonicalHash,
    newHash,
    ...(note ? { detail: note } : {}),
  });
  return { slug, status: "published", cadetHash: newHash, sbHash, warnings: validated(deps, slug, content)?.warnings };
}

function deleteOne(deps: BridgeDeps, state: BridgeState, slug: string, baseHash: string | undefined, note?: string): PageOpResult {
  const slugErr = slugError(slug);
  if (slugErr) return slugErr;
  const now = iso(deps);
  const canonical = readTextOrNull(pagePath(deps.config.conceptsDir, slug));
  const canonicalHash = canonical === null ? null : sha256Hex(canonical);

  if (canonical === null) {
    const already = state.deleted[slug];
    appendJournal(deps.dataDir, { at: now, op: "delete", slug, outcome: "already-absent" });
    return {
      slug,
      status: "unchanged",
      detail: already ? "Page was already deleted by the bridge." : "No page exists for this slug in Cadet memory.",
    };
  }
  if (state.conflicts[slug]) {
    return { slug, status: "conflict", cadetHash: canonicalHash, artifactDir: state.conflicts[slug].artifactDir, detail: "Resolve the recorded conflict first." };
  }
  if (!baseHash || baseHash !== canonicalHash) {
    appendJournal(deps.dataDir, { at: now, op: "delete", slug, outcome: "conflict", prevHash: canonicalHash });
    return {
      slug,
      status: "conflict",
      cadetHash: canonicalHash,
      detail:
        "Deletion requires the exact current hash of the Cadet page (CAS). Fetch the page (op 'page') and retry with its hash.",
    };
  }
  snapshotPage(deps.dataDir, slug, canonical, canonicalHash, now);
  unlinkSync(pagePath(deps.config.conceptsDir, slug));
  state.deleted[slug] = { at: now, hash: canonicalHash };
  delete state.baselines[slug];
  appendJournal(deps.dataDir, {
    at: now,
    op: "delete",
    slug,
    outcome: "deleted",
    prevHash: canonicalHash,
    newHash: null,
    ...(note ? { detail: note } : {}),
  });
  return { slug, status: "deleted", cadetHash: null };
}

function adoptPages(deps: BridgeDeps, state: BridgeState, slugs: string[] | "all", note?: string): PageOpResult[] {
  const now = iso(deps);
  const targets =
    slugs === "all" ? listConceptPages(deps.config.conceptsDir).map((p) => p.slug) : (slugs ?? []);
  const results: PageOpResult[] = [];
  for (const slug of targets) {
    const slugErr = slugError(slug);
    if (slugErr) {
      results.push(slugErr);
      continue;
    }
    const canonical = readTextOrNull(pagePath(deps.config.conceptsDir, slug));
    if (canonical === null) {
      results.push({ slug, status: "missing", detail: "No page exists in Cadet memory for this slug." });
      continue;
    }
    const hash = sha256Hex(canonical);
    state.baselines[slug] = { hash, at: now };
    appendJournal(deps.dataDir, {
      at: now,
      op: "adopt",
      slug,
      outcome: "adopted",
      prevHash: hash,
      newHash: hash,
      detail: note ?? "baseline recorded; no content changed",
    });
    results.push({ slug, status: "unchanged", cadetHash: hash, detail: "Baseline recorded." });
  }
  return results;
}

function resolveConflict(
  deps: BridgeDeps,
  state: BridgeState,
  slug: string,
  action: "keep-cadet" | "publish-sb",
  content: string | undefined,
): PageOpResult {
  const slugErr = slugError(slug);
  if (slugErr) return slugErr;
  const now = iso(deps);
  const conflict = state.conflicts[slug];
  if (!conflict) {
    return { slug, status: "unchanged", detail: "No recorded conflict for this slug." };
  }
  const canonical = readTextOrNull(pagePath(deps.config.conceptsDir, slug));
  const canonicalHash = canonical === null ? null : sha256Hex(canonical);

  if (action === "keep-cadet") {
    if (canonicalHash !== null) state.baselines[slug] = { hash: canonicalHash, at: now };
    state.resolvedKeep[slug] = { at: now, hash: canonicalHash ?? "" };
    delete state.conflicts[slug];
    appendJournal(deps.dataDir, {
      at: now,
      op: "resolve",
      slug,
      outcome: "keep-cadet",
      prevHash: canonicalHash,
      newHash: canonicalHash,
      detail: `kept Cadet version ${shortHash(canonicalHash)}; editor should refresh`,
    });
    return { slug, status: "resolved", cadetHash: canonicalHash, detail: "Kept the Cadet version; refresh the editor copy." };
  }

  // publish-sb: the editor version wins, explicitly, against the displayed
  // current revision. Requires content (or falls back to the artifact).
  let sbContent = content;
  if (sbContent === undefined) {
    try {
      sbContent = readFileSync(`${conflict.artifactDir}/silverbullet.md`, "utf8");
    } catch {
      return { slug, status: "error", issues: ["publish-sb needs the resolved content, or a readable conflict artifact"] };
    }
  }
  const v = validatePageContent(sbContent, slug);
  if (v.issues.length > 0) return { slug, status: "error", issues: v.issues };
  if (canonical !== null) snapshotPage(deps.dataDir, slug, canonical, canonicalHash!, now);
  writePageAtomic(deps.config.conceptsDir, slug, sbContent);
  const newHash = sha256Hex(sbContent);
  state.baselines[slug] = { hash: newHash, at: now };
  delete state.conflicts[slug];
  appendJournal(deps.dataDir, {
    at: now,
    op: "resolve",
    slug,
    outcome: "publish-sb",
    prevHash: canonicalHash,
    newHash,
    detail: `editor version overrode Cadet ${shortHash(canonicalHash)} (explicit resolution)`,
  });
  return { slug, status: "resolved", cadetHash: newHash, detail: "Editor version published as the explicit resolution." };
}

function syncOne(deps: BridgeDeps, state: BridgeState, slug: string, sbContent: string | undefined): SyncVerdict & { slug: string } {
  const slugErr = validateSlug(slug);
  if (slugErr) return { action: "conflict", cadetContent: "", cadetHash: "", artifactDir: "", detail: slugErr };
  const canonical = readTextOrNull(pagePath(deps.config.conceptsDir, slug));
  const canonicalHash = canonical === null ? null : sha256Hex(canonical);
  const baseline = state.baselines[slug];
  const sbHash = sbContent === undefined ? null : sha256Hex(sbContent);

  if (canonicalHash === null) {
    const deleted = state.deleted[slug];
    return {
      action: "deleted-in-cadet",
      detail: deleted
        ? `This page was deleted through the bridge at ${deleted.at}. Delete the editor copy or publish to recreate it.`
        : "No page exists in Cadet memory for this slug (deleted outside the bridge, or never published).",
    } as SyncVerdict & { slug: string };
  }
  if (sbHash !== null && sbHash === canonicalHash) {
    // The editor demonstrably holds the canonical version; a keep-cadet
    // marker is satisfied and can go.
    delete state.resolvedKeep[slug];
    return { action: "current" };
  }
  if (state.resolvedKeep[slug]) {
    return {
      action: "update",
      cadetContent: canonical!,
      cadetHash: canonicalHash,
    };
  }
  if (state.conflicts[slug]) {
    const c = state.conflicts[slug];
    return {
      action: "conflict",
      cadetContent: canonical!,
      cadetHash: canonicalHash,
      artifactDir: c.artifactDir,
      detail: "Recorded conflict: Cadet's copy and the editor's copy both diverged. Both versions are preserved.",
    };
  }
  if (sbHash !== null && baseline && sbHash === baseline.hash) {
    return {
      action: "update",
      cadetContent: canonical!,
      cadetHash: canonicalHash,
    };
  }
  if (baseline && canonicalHash === baseline.hash) {
    return {
      action: "publish-from-editor",
      detail: "The editor copy has unpublished edits and Cadet is unchanged since the last publish — publish instead of refreshing.",
    };
  }
  // Both sides diverged (or no baseline): record the conflict and preserve both.
  const now = iso(deps);
  const artifact = writeConflictArtifact(
    deps.dataDir,
    slug,
    { sb: sbContent ?? "", cadet: canonical! },
    { sbHash, cadetHash: canonicalHash, baselineHash: baseline?.hash ?? null },
    now,
  );
  state.conflicts[slug] = { at: now, sbHash, cadetHash: canonicalHash, artifactDir: artifact.artifactDir };
  appendJournal(deps.dataDir, {
    at: now,
    op: "sync",
    slug,
    outcome: "conflict",
    prevHash: canonicalHash,
    newHash: null,
    detail: `editor ${shortHash(sbHash)} vs cadet ${shortHash(canonicalHash)}; both preserved`,
  });
  return {
    action: "conflict",
    cadetContent: canonical!,
    cadetHash: canonicalHash,
    artifactDir: artifact.artifactDir,
    detail: "Both the editor copy and the Cadet copy changed since the last sync. Both versions are preserved; resolve explicitly.",
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface PublishOptions {
  note?: string;
  /** Set to false to skip the automatic refresh attempt. */
  refresh?: boolean;
}

export async function handleOp(deps: BridgeDeps, payload: Record<string, unknown>): Promise<BridgeResponse> {
  ensureDataDir(deps.dataDir);
  const op = payload.op;
  try {
    return await withMutex(() => dispatch(deps, op, payload));
  } catch (e: unknown) {
    return { ok: false, error: `Mikiedi: ${op} failed: ${(e as Error)?.message ?? String(e)}` };
  }
}

async function dispatch(deps: BridgeDeps, op: unknown, payload: Record<string, unknown>): Promise<BridgeResponse> {
  const state = loadState(deps.dataDir);

  switch (op) {
    case "status": {
      const pages = listConceptPages(deps.config.conceptsDir);
      const result: StatusReport = {
        plugin: "mikiedi",
        version: PLUGIN_VERSION,
        conceptsDir: deps.config.conceptsDir,
        conceptsDirIsDefault: deps.config.conceptsDirIsDefault,
        pageCount: pages.length,
        conflicts: Object.entries(state.conflicts).map(([slug, c]) => ({ slug, at: c.at, artifactDir: c.artifactDir })),
        pendingRefresh: state.pendingRefresh,
        lastRefresh: state.lastRefresh,
        journalTail: readJournalTail(deps.dataDir, 10),
      };
      return { ok: true, op: "status", result };
    }

    case "pages": {
      const pages = listConceptPages(deps.config.conceptsDir).map((p) => ({
        slug: p.slug,
        size: p.size,
        mtime: p.mtimeIso,
        hash: (() => {
          const c = readTextOrNull(pagePath(deps.config.conceptsDir, p.slug));
          return c === null ? null : sha256Hex(c);
        })(),
        lastPublishedAt: state.baselines[p.slug]?.at ?? null,
        conflict: state.conflicts[p.slug]?.at ?? null,
        deletedByBridge: state.deleted[p.slug]?.at ?? null,
      }));
      return { ok: true, op: "pages", result: { pages } };
    }

    case "page": {
      const slug = payload.slug;
      const slugErr = slugError(slug);
      if (slugErr) return { ok: true, op: "page", result: slugErr };
      const content = readTextOrNull(pagePath(deps.config.conceptsDir, slug as string));
      return {
        ok: true,
        op: "page",
        result: { slug, content, hash: content === null ? null : sha256Hex(content) },
      };
    }

    case "validate": {
      const pages = (payload.pages ?? []) as StagedPage[];
      const results = pages.map((p) => {
        const slugErr = slugError(p.slug);
        if (slugErr) return slugErr;
        const v = validatePageContent(typeof p.content === "string" ? p.content : "", p.slug);
        return { slug: p.slug, status: v.issues.length === 0 ? "published" : "error", issues: v.issues, warnings: v.warnings };
      });
      return { ok: true, op: "validate", result: { pages: results } };
    }

    case "publish": {
      const pages = (payload.pages ?? []) as StagedPage[];
      if (!Array.isArray(pages) || pages.length === 0) {
        return { ok: false, error: "Mikiedi: publish needs a non-empty 'pages' array of {slug, content}" };
      }
      const results: PageOpResult[] = [];
      for (const page of pages) {
        results.push(await publishOne(deps, state, page, typeof payload.note === "string" ? payload.note : undefined));
      }
      saveState(deps.dataDir, state);
      let refresh: RefreshResult | undefined;
      const changed = results.some((r) => r.status === "published");
      if (changed && payload.refresh !== false) {
        refresh = await doRefresh(deps, state);
        saveState(deps.dataDir, state);
      }
      return { ok: true, op: "publish", result: { pages: results, ...(refresh ? { refresh } : {}) } };
    }

    case "delete": {
      const result = deleteOne(
        deps,
        state,
        String(payload.slug ?? ""),
        typeof payload.baseHash === "string" ? payload.baseHash : undefined,
        typeof payload.note === "string" ? payload.note : undefined,
      );
      saveState(deps.dataDir, state);
      let refresh: RefreshResult | undefined;
      if (result.status === "deleted" && payload.refresh !== false) {
        refresh = await doRefresh(deps, state);
        saveState(deps.dataDir, state);
      }
      return { ok: true, op: "delete", result: { pages: [result], ...(refresh ? { refresh } : {}) } };
    }

    case "adopt": {
      const slugs = payload.slugs === undefined ? "all" : payload.slugs;
      if (slugs !== "all" && !Array.isArray(slugs)) {
        return { ok: false, error: "Mikiedi: adopt needs either {slugs: 'all'} or {slugs: [..]}" };
      }
      const results = adoptPages(
        deps,
        state,
        slugs as string[] | "all",
        typeof payload.note === "string" ? payload.note : undefined,
      );
      saveState(deps.dataDir, state);
      return { ok: true, op: "adopt", result: { pages: results } };
    }

    case "resolve": {
      const action = payload.action;
      if (action !== "keep-cadet" && action !== "publish-sb") {
        return { ok: false, error: "Mikiedi: resolve needs action 'keep-cadet' or 'publish-sb'" };
      }
      const result = resolveConflict(
        deps,
        state,
        String(payload.slug ?? ""),
        action,
        typeof payload.content === "string" ? payload.content : undefined,
      );
      saveState(deps.dataDir, state);
      let refresh: RefreshResult | undefined;
      if (result.status === "resolved" && action === "publish-sb" && payload.refresh !== false) {
        refresh = await doRefresh(deps, state);
        saveState(deps.dataDir, state);
      }
      return { ok: true, op: "resolve", result: { pages: [result], ...(refresh ? { refresh } : {}) } };
    }

    case "sync": {
      const slug = String(payload.slug ?? "");
      const slugErr = slugError(slug);
      if (slugErr) return { ok: true, op: "sync", result: slugErr };
      const verdict = syncOne(
        deps,
        state,
        slug,
        typeof payload.content === "string" ? payload.content : undefined,
      );
      saveState(deps.dataDir, state);
      return { ok: true, op: "sync", result: verdict };
    }

    case "refresh": {
      const refresh = await doRefresh(deps, state);
      saveState(deps.dataDir, state);
      return { ok: true, op: "refresh", result: refresh };
    }

    default:
      return {
        ok: false,
        error: `Mikiedi: unknown op '${String(op)}'. Valid ops: status, pages, page, validate, publish, delete, adopt, resolve, sync, refresh.`,
      };
  }
}

/** Factory used by the HTTP route (and override-friendly for tests). */
export function makeDeps(pluginRoot: string): BridgeDeps {
  const config = loadConfig(pluginRoot, null);
  const workspace = process.env.CADET_WORKSPACE_DIR ?? "";
  return {
    config,
    dataDir: `${pluginRoot}/data`,
    workspaceDir: workspace || config.conceptsDir,
  };
}

export { emptyState };
