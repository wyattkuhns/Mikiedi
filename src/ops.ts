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
import { readBridgePage, writeBridgePageAtomic, snapshotPage, writeConflictArtifact, listBridgePages, deleteBridgePage } from "./store.ts";
import { isRootSlug } from "./roots.ts";
import { OpLock } from "./lock.ts";
import { parseRetention, applyRetention, type Retention, type PruneReport } from "./retention.ts";
import { recordVersion, readVersionIndex, readVersionContent, findVersionByHash, type VersionEntry } from "./versions.ts";
import { diffContents, type DiffHunk } from "./diff.ts";

export interface BridgeDeps {
  config: ResolvedConfig;
  /** Plugin data directory (state, journal, snapshots, conflicts). */
  dataDir: string;
  workspaceDir: string;
  refresh?: () => Promise<RefreshResult>;
  now?: () => Date;
  /** v0.3 retention policies, attached per request from the payload. */
  logRetention?: Retention;
  versionRetention?: Retention;
}

export interface StagedPage {
  slug: string;
  content: string;
  /** Full-byte hash of the canonical page this edit was based on, when known. */
  baseHash?: string;
}

export interface PageOpResult {
  slug: string;
  status: "published" | "conflict" | "adopt-required" | "deleted" | "resolved" | "unchanged" | "missing" | "error" | "stale-editor";
  issues?: string[];
  warnings?: string[];
  cadetHash?: string | null;
  sbHash?: string;
  artifactDir?: string;
  cadetContent?: string;
  detail?: string;
  /** Undo/redo availability after the op (panel UI). */
  undoCount?: number;
  redoCount?: number;
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

const PLUGIN_VERSION = "0.4.0";

function iso(deps: BridgeDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

/** Log-retention policy for this request (payload `retention.log`). */
function logPolicy(deps: BridgeDeps): Retention {
  return deps.logRetention ?? { kind: "forever" };
}

/** Writes a journal entry unless log retention is "never". */
function journal(deps: BridgeDeps, entry: Parameters<typeof appendJournal>[1]): void {
  appendJournal(deps.dataDir, entry, { disabled: logPolicy(deps).kind === "never" });
}

const STOMP_WINDOW_MS = 90_000; // default multi-tab advisory window

/**
 * Multi-session stomp guard: another editor session published this slug
 * very recently and this publish comes from a different session with
 * different content. Return an advisory verdict instead of writing or
 * recording a conflict — the stale editor should Refresh first. Same
 * session (the same tab) and identical content pass straight through.
 */
function stompCheck(
  deps: BridgeDeps,
  state: BridgeState,
  slug: string,
  sbHash: string,
  session: string | undefined,
  now: string,
): PageOpResult | null {
  if (!session) return null; // callers without a session id skip the guard
  const rec = state.recentPublishes[slug];
  if (!rec || rec.sessionId === session) return null;
  const prevTs = Date.parse(rec.at);
  const nowTs = Date.parse(now);
  if (!Number.isFinite(prevTs) || !Number.isFinite(nowTs)) return null;
  if (nowTs - prevTs > STOMP_WINDOW_MS) return null;
  if (rec.hash === sbHash) return null; // identical content; idempotent
  return {
    slug,
    status: "stale-editor",
    cadetHash: rec.hash,
    sbHash,
    detail:
      `This page was published from another editor session ${(nowTs - prevTs) / 1000}s ago (likely another ` +
      "SilverBullet tab). Refresh from Cadet (Mikiedi: Refresh from Cadet) to load that version, then publish " +
      "again if your edit still applies. Nothing was written or overwritten.",
  };
}

/**
 * Deletes the store file for a slug. Root assistant files never reach this —
 * deleteOne and restoreState guard them first — but the guard lives here too
 * so no future caller can unlink NOW.md by accident.
 */
function deleteBridgePage(deps: BridgeDeps, slug: string): void {
  if (isRootSlug(slug)) {
    throw new Error("Mikiedi: root assistant files cannot be deleted via the bridge");
  }
  unlinkSync(pagePath(deps.config.conceptsDir, slug));
}

/**
 * CAS window narrowing: re-read and re-hash the canonical file immediately
 * before the atomic write. A Cadet-side writer (native ingest, direct file
 * edits) that lands between the op's initial check and this point aborts
 * the write as a conflict instead of silently clobbering.
 */
function reVerify(deps: BridgeDeps, slug: string, expectedHash: string | null): { ok: boolean; content: string | null } {
  const current = readBridgePage(deps.workspaceDir, deps.config.conceptsDir, slug);
  const currentHash = current === null ? null : sha256Hex(current);
  return { ok: currentHash === expectedHash, content: current };
}

/** Records the previous state on the undo stack; any new edit clears redo. */
function pushUndo(
  state: BridgeState,
  slug: string,
  prevHash: string | null,
  ts: string,
  op: string,
): void {
  const stack = state.undoStacks[slug] ?? (state.undoStacks[slug] = []);
  stack.push({ hash: prevHash, ts, op });
  if (stack.length > 100) stack.splice(0, stack.length - 100);
  state.redoStacks[slug] = [];
}

/** Seeds the version chain with the pre-bridge content so diffs can reach
 * back before the bridge's first write of a page. */
function seedPreImage(deps: BridgeDeps, slug: string, canonical: string | null, now: string): void {
  if (canonical === null) return;
  if (readVersionIndex(deps.dataDir, slug).length === 0) {
    recordVersion(deps.dataDir, slug, canonical, { ts: now, op: "pre-existing", outcome: "seeded" });
  }
}

function stackCounts(state: BridgeState, slug: string): { undoCount: number; redoCount: number } {
  return { undoCount: (state.undoStacks[slug] ?? []).length, redoCount: (state.redoStacks[slug] ?? []).length };
}

/**
 * Restores a slug to a recorded state (hash or tombstone). Used by undo and
 * redo. Content comes from the version store; CAS semantics apply (the
 * restore itself is a state change and is journalled + version-recorded).
 */
function restoreState(
  deps: BridgeDeps,
  state: BridgeState,
  slug: string,
  target: { hash: string | null; ts: string; op: string },
  label: "undo" | "redo",
  session: string | undefined,
): PageOpResult {
  const now = iso(deps);
  const canonical = readBridgePage(deps.workspaceDir, deps.config.conceptsDir, slug);
  const canonicalHash = canonical === null ? null : sha256Hex(canonical);
  if (canonicalHash === target.hash) {
    return { slug, status: "unchanged", detail: `${label}: page is already in the target state.` };
  }

  let content: string | null = null;
  if (target.hash !== null) {
    const entry = findVersionByHash(deps.dataDir, slug, target.hash);
    content = entry ? readVersionContent(deps.dataDir, slug, entry) : null;
    if (content === null) {
      return {
        slug,
        status: "error",
        issues: [
          `${label}: no stored content for ${shortHash(target.hash)} in the version store ` +
            "(pruned by version retention, or recorded by an older version).",
        ],
      };
    }
  }

  const recheck = reVerify(deps, slug, canonicalHash);
  if (!recheck.ok) {
    journal(deps, {
      at: now,
      op: label,
      slug,
      outcome: "conflict",
      prevHash: canonicalHash,
      detail: "canonical changed between check and restore (external writer); nothing written",
    });
    return {
      slug,
      status: "conflict",
      cadetHash: sha256Hex(recheck.content ?? ""),
      detail: "The page changed on the Cadet side between check and restore (external writer). Nothing was written.",
    };
  }

  if (target.hash === null) {
    if (isRootSlug(slug)) {
      return { slug, status: "error", issues: ["root assistant files are protected and cannot be deleted via the bridge"] };
    }
    deleteBridgePage(deps, slug);
    state.deleted[slug] = { at: now, hash: canonicalHash! };
    delete state.baselines[slug];
  } else {
    writeBridgePageAtomic(deps.workspaceDir, deps.config.conceptsDir, slug, content!);
    state.baselines[slug] = { hash: target.hash, at: now };
    delete state.deleted[slug];
    // Restoring exactly the kept version demonstrably satisfies keep-cadet.
    if (state.resolvedKeep[slug] && target.hash === state.resolvedKeep[slug].hash) delete state.resolvedKeep[slug];
  }

  recordVersion(deps.dataDir, slug, target.hash === null ? null : content, {
    ts: now,
    op: label,
    outcome: "restored",
    sessionId: session,
  });
  journal(deps, {
    at: now,
    op: label,
    slug,
    outcome: "restored",
    prevHash: canonicalHash,
    newHash: target.hash,
    detail: `${label}: restored state from ${target.ts} (${target.op})`,
  });
  return { slug, status: target.hash === null ? "deleted" : "published", cadetHash: target.hash, detail: `${label}: restored the state from ${target.ts}.` };
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
  session: string | undefined,
): Promise<PageOpResult> {
  const slugErr = slugError(page.slug);
  if (slugErr) return slugErr;
  const slug = page.slug as string;
  const content = typeof page.content === "string" ? page.content : "";
  const contentErr = validated(deps, slug, content);
  if (contentErr) return contentErr;

  const now = iso(deps);
  const canonical = readBridgePage(deps.workspaceDir, deps.config.conceptsDir, slug);
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
    const stomp = stompCheck(deps, state, slug, sbHash, session, now);
    if (stomp) return stomp;
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
      journal(deps, {
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

  // CAS window closed: the write only lands if the canonical file is still
  // byte-identical to what this op checked moments ago.
  const recheck = reVerify(deps, slug, canonicalHash);
  if (!recheck.ok) {
    const racedHash = sha256Hex(recheck.content ?? "");
    journal(deps, {
      at: now,
      op: "publish",
      slug,
      outcome: "conflict",
      prevHash: racedHash,
      detail: `canonical changed between check and write (${shortHash(canonicalHash)} -> ${shortHash(racedHash)}); nothing written`,
    });
    return {
      slug,
      status: "conflict",
      cadetHash: racedHash,
      sbHash,
      detail:
        "The page changed on the Cadet side between this op's check and its write (an external writer). " +
        "Nothing was written; run the op again to reconcile against the new content.",
    };
  }

  const identical = canonicalHash === sha256Hex(content);
  if (canonical !== null) {
    snapshotPage(deps.dataDir, slug, canonical, canonicalHash!, now);
  }
  writeBridgePageAtomic(deps.workspaceDir, deps.config.conceptsDir, slug, content);
  const newHash = sha256Hex(content);
  state.baselines[slug] = { hash: newHash, at: now };
  delete state.deleted[slug];
  // Republishing the exact canonical bytes clears a keep-cadet marker: the
  // editor demonstrably has the kept version in hand.
  if (canonicalHash !== null && newHash === canonicalHash) delete state.resolvedKeep[slug];
  if (canonicalHash === null) delete state.resolvedKeep[slug];

  if (identical) {
    journal(deps, {
      at: now,
      op: "publish",
      slug,
      outcome: "unchanged",
      prevHash: canonicalHash,
      newHash,
      ...(note ? { detail: note } : {}),
    });
  } else {
    seedPreImage(deps, slug, canonical, now);
    recordVersion(deps.dataDir, slug, content, { ts: now, op: "publish", outcome: canonical === null ? "created" : "updated", sessionId: session, note });
    pushUndo(state, slug, canonicalHash, now, "publish");
    journal(deps, {
      at: now,
      op: "publish",
      slug,
      outcome: canonical === null ? "created" : "updated",
      prevHash: canonicalHash,
      newHash,
      ...(note ? { detail: note } : {}),
    });
  }
  state.recentPublishes[slug] = { at: now, hash: newHash, sessionId: session ?? "" };
  return {
    slug,
    status: "published",
    cadetHash: newHash,
    sbHash,
    warnings: validated(deps, slug, content)?.warnings,
    ...stackCounts(state, slug),
  };
}

function deleteOne(deps: BridgeDeps, state: BridgeState, slug: string, baseHash: string | undefined, note?: string, session?: string): PageOpResult {
  const slugErr = slugError(slug);
  if (slugErr) return slugErr;
  if (isRootSlug(slug)) {
    return {
      slug,
      status: "error",
      issues: ["root assistant files (NOW, SOUL, IDENTITY, HEARTBEAT) are protected and cannot be deleted via the bridge"],
    };
  }
  const now = iso(deps);
  const canonical = readBridgePage(deps.workspaceDir, deps.config.conceptsDir, slug);
  const canonicalHash = canonical === null ? null : sha256Hex(canonical);

  if (canonical === null) {
    const already = state.deleted[slug];
    journal(deps, { at: now, op: "delete", slug, outcome: "already-absent" });
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
    journal(deps, { at: now, op: "delete", slug, outcome: "conflict", prevHash: canonicalHash });
    return {
      slug,
      status: "conflict",
      cadetHash: canonicalHash,
      detail:
        "Deletion requires the exact current hash of the Cadet page (CAS). Fetch the page (op 'page') and retry with its hash.",
    };
  }
  const recheck = reVerify(deps, slug, canonicalHash);
  if (!recheck.ok) {
    journal(deps, {
      at: now,
      op: "delete",
      slug,
      outcome: "conflict",
      prevHash: canonicalHash,
      detail: "canonical changed between check and delete (external writer); nothing deleted",
    });
    return {
      slug,
      status: "conflict",
      cadetHash: sha256Hex(recheck.content ?? ""),
      detail: "The page changed on the Cadet side between check and delete (external writer). Nothing was deleted.",
    };
  }
  snapshotPage(deps.dataDir, slug, canonical, canonicalHash, now);
  deleteBridgePage(deps, slug);
  state.deleted[slug] = { at: now, hash: canonicalHash };
  delete state.baselines[slug];
  recordVersion(deps.dataDir, slug, null, { ts: now, op: "delete", outcome: "deleted", sessionId: session, note });
  pushUndo(state, slug, canonicalHash, now, "delete");
  journal(deps, {
    at: now,
    op: "delete",
    slug,
    outcome: "deleted",
    prevHash: canonicalHash,
    newHash: null,
    ...(note ? { detail: note } : {}),
  });
  return { slug, status: "deleted", cadetHash: null, ...stackCounts(state, slug) };
}

function adoptPages(deps: BridgeDeps, state: BridgeState, slugs: string[] | "all", note?: string): PageOpResult[] {
  const now = iso(deps);
  const targets =
    slugs === "all" ? listBridgePages(deps.workspaceDir, deps.config.conceptsDir).map((p) => p.slug) : (slugs ?? []);
  const results: PageOpResult[] = [];
  for (const slug of targets) {
    const slugErr = slugError(slug);
    if (slugErr) {
      results.push(slugErr);
      continue;
    }
    const canonical = readBridgePage(deps.workspaceDir, deps.config.conceptsDir, slug);
    if (canonical === null) {
      results.push({ slug, status: "missing", detail: "No page exists in Cadet memory for this slug." });
      continue;
    }
    const hash = sha256Hex(canonical);
    state.baselines[slug] = { hash, at: now };
    journal(deps, {
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
  session?: string,
): PageOpResult {
  const slugErr = slugError(slug);
  if (slugErr) return slugErr;
  const now = iso(deps);
  const conflict = state.conflicts[slug];
  if (!conflict) {
    return { slug, status: "unchanged", detail: "No recorded conflict for this slug." };
  }
  const canonical = readBridgePage(deps.workspaceDir, deps.config.conceptsDir, slug);
  const canonicalHash = canonical === null ? null : sha256Hex(canonical);

  if (action === "keep-cadet") {
    if (canonicalHash !== null) state.baselines[slug] = { hash: canonicalHash, at: now };
    state.resolvedKeep[slug] = { at: now, hash: canonicalHash ?? "" };
    delete state.conflicts[slug];
    journal(deps, {
      at: now,
      op: "resolve",
      slug,
      outcome: "keep-cadet",
      prevHash: canonicalHash,
      newHash: canonicalHash,
      detail: `kept Cadet version ${shortHash(canonicalHash)}; editor should refresh`,
    });
    return { slug, status: "resolved", cadetHash: canonicalHash, detail: "Kept the Cadet version; refresh the editor copy.", ...stackCounts(state, slug) };
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
  const recheck = reVerify(deps, slug, canonicalHash);
  if (!recheck.ok) {
    journal(deps, {
      at: now,
      op: "resolve",
      slug,
      outcome: "conflict",
      prevHash: canonicalHash,
      detail: "canonical changed between check and resolve (external writer); nothing written",
    });
    return {
      slug,
      status: "conflict",
      cadetHash: sha256Hex(recheck.content ?? ""),
      detail: "The page changed on the Cadet side between check and resolve (external writer). Nothing was written.",
    };
  }
  if (canonical !== null) snapshotPage(deps.dataDir, slug, canonical, canonicalHash!, now);
  writeBridgePageAtomic(deps.workspaceDir, deps.config.conceptsDir, slug, sbContent);
  const newHash = sha256Hex(sbContent);
  state.baselines[slug] = { hash: newHash, at: now };
  delete state.conflicts[slug];
  seedPreImage(deps, slug, canonical, now);
  recordVersion(deps.dataDir, slug, sbContent, { ts: now, op: "resolve", outcome: "publish-sb", sessionId: session });
  pushUndo(state, slug, canonicalHash, now, "resolve");
  journal(deps, {
    at: now,
    op: "resolve",
    slug,
    outcome: "publish-sb",
    prevHash: canonicalHash,
    newHash,
    detail: `editor version overrode Cadet ${shortHash(canonicalHash)} (explicit resolution)`,
  });
  return { slug, status: "resolved", cadetHash: newHash, detail: "Editor version published as the explicit resolution.", ...stackCounts(state, slug) };
}

function syncOne(deps: BridgeDeps, state: BridgeState, slug: string, sbContent: string | undefined): SyncVerdict & { slug: string } {
  const slugErr = validateSlug(slug);
  if (slugErr) return { action: "conflict", cadetContent: "", cadetHash: "", artifactDir: "", detail: slugErr };
  const canonical = readBridgePage(deps.workspaceDir, deps.config.conceptsDir, slug);
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
  journal(deps, {
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
  // v0.3: retention policies ride on the payload (composed by the SB library
  // from its config). Absent = sensible defaults (log forever, versions forever).
  const retentionSpec = (payload.retention ?? {}) as { log?: unknown; versions?: unknown };
  deps.logRetention = parseRetention(retentionSpec.log, { kind: "forever" });
  deps.versionRetention = parseRetention(retentionSpec.versions, { kind: "forever" });
  // Cross-process lock. The in-process mutex is taken FIRST so concurrent
  // same-process ops queue politely as before; the file lock then serializes
  // across processes. The stale threshold exceeds the worst op duration
  // (a held refresh subprocess can run up to refreshTimeoutMs); a genuinely
  // alive holder is never broken, so callers queue behind it rather than fail.
  const threshold = Math.max(deps.config.refreshTimeoutMs + 30_000, 60_000);
  const lock = new OpLock(deps.dataDir, threshold, 25, threshold);
  try {
    return await withMutex(async () => {
      await lock.acquire();
      try {
        return await dispatch(deps, op, payload);
      } finally {
        lock.release();
      }
    });
  } catch (e: unknown) {
    const detail = `Mikiedi: ${op} failed: ${(e as Error)?.message ?? String(e)}`;
    try {
      appendJournal(deps.dataDir, {
        at: iso(deps),
        op: String(op ?? "unknown"),
        slug: "",
        outcome: "error",
        detail,
      });
    } catch {
      // journaling must never mask the real failure
    }
    return { ok: false, error: detail };
  }
}

async function dispatch(deps: BridgeDeps, op: unknown, payload: Record<string, unknown>): Promise<BridgeResponse> {
  const state = loadState(deps.dataDir);

  switch (op) {
    case "status": {
      const pages = listBridgePages(deps.workspaceDir, deps.config.conceptsDir);
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
      const pages = listBridgePages(deps.workspaceDir, deps.config.conceptsDir).map((p) => ({
        slug: p.slug,
        size: p.size,
        mtime: p.mtimeIso,
        hash: (() => {
          const c = readBridgePage(deps.workspaceDir, deps.config.conceptsDir, p.slug);
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
      const content = readBridgePage(deps.workspaceDir, deps.config.conceptsDir, slug as string);
      return {
        ok: true,
        op: "page",
        result: { slug, content, hash: content === null ? null : sha256Hex(content) },
      };
    }

    case "fetchAll": {
      const summaries = listBridgePages(deps.workspaceDir, deps.config.conceptsDir);
      const pages = summaries.map((p) => {
        const content = readBridgePage(deps.workspaceDir, deps.config.conceptsDir, p.slug);
        return {
          slug: p.slug,
          content: content ?? "",
          hash: content === null ? null : sha256Hex(content),
          size: p.size,
          mtime: p.mtimeIso,
        };
      });
      return {
        ok: true,
        op: "fetchAll",
        result: {
          pages,
          conflicts: Object.keys(state.conflicts),
          generatedAt: iso(deps),
        },
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
      const session = typeof payload.session === "string" ? payload.session : undefined;
      const results: PageOpResult[] = [];
      for (const page of pages) {
        results.push(await publishOne(deps, state, page, typeof payload.note === "string" ? payload.note : undefined, session));
      }
      // Validation and slug errors are journalled too (the log panel shows failures).
      for (const r of results) {
        if (r.status === "error" || r.status === "stale-editor") {
          journal(deps, {
            at: iso(deps),
            op: "publish",
            slug: r.slug,
            outcome: r.status,
            detail: (r.issues ?? [r.detail ?? ""]).join("; ") || undefined,
          });
        }
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
        typeof payload.session === "string" ? payload.session : undefined,
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
        typeof payload.session === "string" ? payload.session : undefined,
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

    case "log": {
      const count = typeof payload.count === "number" && payload.count > 0 ? Math.min(payload.count, 500) : 50;
      return { ok: true, op: "log", result: { entries: readJournalTail(deps.dataDir, count) } };
    }

    case "versions": {
      const slug = String(payload.slug ?? "");
      const slugErr = slugError(slug);
      if (slugErr) return { ok: true, op: "versions", result: slugErr };
      const canonical = readBridgePage(deps.workspaceDir, deps.config.conceptsDir, slug);
      return {
        ok: true,
        op: "versions",
        result: {
          slug,
          versions: readVersionIndex(deps.dataDir, slug),
          currentHash: canonical === null ? null : sha256Hex(canonical),
          ...stackCounts(state, slug),
        },
      };
    }

    case "diff": {
      const slug = String(payload.slug ?? "");
      const slugErr = slugError(slug);
      if (slugErr) return { ok: true, op: "diff", result: slugErr };
      const resolve = (spec: unknown): { text: string; hash: string | null; error?: string } => {
        if (spec === "current") {
          const text = readBridgePage(deps.workspaceDir, deps.config.conceptsDir, slug);
          return { text: text ?? "", hash: text === null ? null : sha256Hex(text) };
        }
        if (typeof spec === "string") {
          const entry = findVersionByHash(deps.dataDir, slug, spec);
          if (!entry) return { text: "", hash: null, error: `no recorded version with hash ${shortHash(spec)}` };
          const text = readVersionContent(deps.dataDir, slug, entry);
          if (text === null) return { text: "", hash: null, error: `content pruned or unreadable for ${shortHash(spec)}` };
          return { text, hash: spec };
        }
        return { text: "", hash: null, error: "side must be a version hash or 'current'" };
      };
      const a = resolve(payload.from ?? "current");
      const b = resolve(payload.to ?? "current");
      if (a.error || b.error) {
        return {
          ok: true,
          op: "diff",
          result: { slug, status: "error", issues: [a.error, b.error].filter(Boolean) },
        };
      }
      const context = typeof payload.context === "number" ? payload.context : 3;
      return {
        ok: true,
        op: "diff",
        result: {
          slug,
          fromHash: a.hash,
          toHash: b.hash,
          hunks: diffContents(a.text, b.text, context),
        },
      };
    }

    case "undo": {
      const slug = String(payload.slug ?? "");
      const slugErr = slugError(slug);
      if (slugErr) return { ok: true, op: "undo", result: slugErr };
      const stack = state.undoStacks[slug] ?? [];
      const target = stack.pop();
      if (!target) {
        return {
          ok: true,
          op: "undo",
          result: { pages: [{ slug, status: "unchanged", detail: "Nothing to undo (no recorded previous state).", ...stackCounts(state, slug) }] },
        };
      }
      // The state the restore will replace becomes the redo target.
      const current = readBridgePage(deps.workspaceDir, deps.config.conceptsDir, slug);
      const currentHash = current === null ? null : sha256Hex(current);
      const result = restoreState(deps, state, slug, target, "undo", typeof payload.session === "string" ? payload.session : undefined);
      if (result.status === "published" || result.status === "deleted") {
        state.redoStacks[slug] = state.redoStacks[slug] ?? [];
        state.redoStacks[slug].push({ hash: currentHash, ts: target.ts, op: "undo" });
      } else {
        // Nothing changed (error/conflict/unchanged): put the entry back.
        stack.push(target);
      }
      saveState(deps.dataDir, state);
      let refresh: RefreshResult | undefined;
      if ((result.status === "published" || result.status === "deleted") && payload.refresh !== false) {
        refresh = await doRefresh(deps, state);
        saveState(deps.dataDir, state);
      }
      return { ok: true, op: "undo", result: { pages: [{ ...result, ...stackCounts(state, slug) }], ...(refresh ? { refresh } : {}) } };
    }

    case "redo": {
      const slug = String(payload.slug ?? "");
      const slugErr = slugError(slug);
      if (slugErr) return { ok: true, op: "redo", result: slugErr };
      const stack = state.redoStacks[slug] ?? [];
      const target = stack.pop();
      if (!target) {
        return {
          ok: true,
          op: "redo",
          result: { pages: [{ slug, status: "unchanged", detail: "Nothing to redo.", ...stackCounts(state, slug) }] },
        };
      }
      const current = readBridgePage(deps.workspaceDir, deps.config.conceptsDir, slug);
      const currentHash = current === null ? null : sha256Hex(current);
      const result = restoreState(deps, state, slug, target, "redo", typeof payload.session === "string" ? payload.session : undefined);
      if (result.status === "published" || result.status === "deleted") {
        state.undoStacks[slug] = state.undoStacks[slug] ?? [];
        state.undoStacks[slug].push({ hash: currentHash, ts: target.ts, op: "redo" });
      } else {
        stack.push(target);
      }
      saveState(deps.dataDir, state);
      let refresh: RefreshResult | undefined;
      if ((result.status === "published" || result.status === "deleted") && payload.refresh !== false) {
        refresh = await doRefresh(deps, state);
        saveState(deps.dataDir, state);
      }
      return { ok: true, op: "redo", result: { pages: [{ ...result, ...stackCounts(state, slug) }], ...(refresh ? { refresh } : {}) } };
    }

    case "prune": {
      const report: PruneReport = applyRetention(deps.dataDir, deps.logRetention ?? { kind: "forever" }, deps.versionRetention ?? { kind: "forever" }, Date.parse(iso(deps)));
      journal(deps, {
        at: iso(deps),
        op: "prune",
        slug: "",
        outcome: "pruned",
        detail: `journal archived ${report.journalArchived} (cleared=${report.journalCleared}); versions removed ${report.versionsRemoved} across ${report.slugsTouched.length} slug(s)`,
      });
      return { ok: true, op: "prune", result: report };
    }

    default:
      return {
        ok: false,
        error: `Mikiedi: unknown op '${String(op)}'. Valid ops: status, pages, page, fetchAll, validate, publish, delete, adopt, resolve, sync, refresh, log, versions, diff, undo, redo, prune.`,
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
    // Root-page mapping (NOW/SOUL/IDENTITY/HEARTBEAT) only applies when the
    // real workspace root is known; without it the helpers no-op.
    workspaceDir: workspace,
  };
}

export { emptyState };
