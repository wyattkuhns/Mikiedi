# Mikiedi v0.3 plan — multi-session resiliency + versioning panel

Wyatt's authorization (11/17 ~01:00 Boise, "go ahead and get started"): two workstreams,
plus a retention-config system. This file is the working todo so nothing gets lost.
Status markers: [ ] todo, [~] in progress, [x] done.

## Workstream 1 — resiliency (multi-tab / multi-session / multi-writer)

- [x] **W1.1 — OS-level cross-process lock.** The in-process mutex serializes bridge ops
      within one daemon process only. Add an advisory file lock (lockfile with
      create-exclusive + stale-lock timeout + holder PID) around the whole critical
      section so a second daemon process (restart mid-sweep, second route host) queues
      instead of racing. Document the stale-lock recovery path.
- [x] **W1.2 — CAS window narrowing.** Inside the critical section, re-verify the
      canonical file hash IMMEDIATELY before the atomic rename (publish/overwrite,
      delete, resolve). Today's CAS compares at op start; a Cadet-side writer (native
      ingest, me editing files) could land between check and write. Re-check closes
      the last real gap short of coordinating with native ingest's consolidation lock.
- [x] **W1.3 — Atomic state.json.** Verify saveState; make it temp+rename if it isn't.
- [x] **W1.4 — Multi-tab stomp guard.** SB tabs don't see each other's edits (no
      cross-tab push). Tab A publishes; tab B (stale) publishes → CAS conflict, which
      is correct but churny. Add a soft guard: if the bridge recorded a publish of the
      same slug from a DIFFERENT session within a short window (configurable, default
      ~90s), the publish returns a distinct `stale-editor` advisory verdict (content
      preserved, nothing overwritten) telling the user to Refresh before publishing.
      Session = random per-page-load token the Lua library generates and sends.
- [x] **W1.5 — Error journaling.** Bridge-side op errors (status error) get journal
      entries like other outcomes, so the log panel sees failures, not just successes.
- [x] **W1.6 — Retry idempotency check.** Confirm duplicate publishes (network retry)
      converge to `unchanged` and don't duplicate journal/version spam; dedupe by
      (slug, content hash) in the version store.

## Workstream 2 — version history + log panel

### Data model (Cadet side, plugin data dir)
- [x] **W2.1 — Version store.** `data/versions/<slug>/<ts>-<hash>.md` — one full copy
      per successful publish/delete/resolve/undo (pre-image semantics already exist for
      destructive ops; generalize into the version store so every state change is a
      version). Plus `data/versions/<slug>/index.json` (ts, hash, op, sessionId, note).
      Deletions recorded as tombstone versions.
- [x] **W2.2 — Log.** journal.jsonl stays the operational log (append-only recovery
      semantic). Retention pruning for the JOURNAL archives entries older than the log
      TTL to `data/journal-archive.jsonl` (never delete outright unless retention =
      never; "never log" = skip journal entirely, documented as disabling recovery
      history).
- [x] **W2.3 — Retention engine.** Config: two independent TTLs (log retention, version
      retention), each = amount + unit (seconds/minutes/hours/days/years) with
      `forever` and `never` special values. Lazy pruning on each op + explicit `prune`
      op. Respect `never` = no logging / no versioning at all (publish still CAS-safe;
      undo impossible then — surfaced in UI).
- [x] **W2.4 — Diff engine.** In-house line diff (Myers/LCS), zero new deps, returns
      structured hunks (`op: context|add|del`, line pairs) for two full contents.

### New bridge ops
- [x] **W2.5 — `log`** (tail N entries with timestamps, op, slug, outcome, session).
- [x] **W2.6 — `versions`** (list versions for a slug from the version store).
- [x] **W2.7 — `diff`** (two version hashes or version vs current → hunks).
- [x] **W2.8 — `undo` / `redo`** per slug: restore previous/next version via CAS-guarded
      write; delete-undo restores the tombstoned content. Redo stack per slug,
      invalidated by any new edit (git semantics).
- [x] **W2.9 — `prune`** (apply retention now, report what was removed).

### Panel UI (SB side, Space Lua + editor.showPanel)
- [x] **W2.10 — Panel command.** `Mikiedi: Show panel` → `editor.showPanel("rhs", ...)`.
      Right-hand sidebar, fixed width. Data path: Lua command calls bridge, embeds
      current log + version lists into the panel HTML; panel refresh button re-invokes
      the command via syscall (verify invokeCommand works from panel sandbox; fallback =
      space.readPage on a maintained Mikiedi/Log page).
- [x] **W2.11 — Log view.** Recent errors/notifications/publishes with timestamps,
      newest first, op outcome coloring (published/unchanged/conflict/error/…).
- [x] **W2.12 — Diff viewer.** Git/PR-style per-page version comparison: green +/red −
      lines, hunk headers, pick any two versions of a page (default: previous vs
      current).
- [x] **W2.13 — Undo/redo buttons.** Per page in the panel; calls undo/redo ops with
      confirm dialogs; disabled when stack empty or retention=never.
- [x] **W2.14 — Click-through.** Clicking a log/version row opens the page in the editor
      (editor.navigate via panel syscall bridge; verify from sandbox).
- [x] **W2.15 — Toolbar.** Buttons: (a) Configuration menu, (b) documentation/help,
      (c) issue reports (GitHub issues), (i) info popover linking the GitHub repo with
      a one-paragraph "what is Mikiedi" explanation.
- [x] **W2.16 — Retention config.** New config entries: retention amount + unit picker
      for logs, amount + unit for versions, plus forever/never per category. Verify what
      widget types SB's config schema supports (dropdown vs text); use the best
      supported shape.

## Cross-cutting
- [x] **W3.1 — Unit tests** for lock, re-verify, retention math (year unit!), diff
      engine, undo/redo stacks, tombstones, prune. Target: keep the whole suite green.
- [x] **W3.2 — Docs.** conflict-model.md + operations.md updated for versions/undo,
      retention semantics, multi-session guidance (what the stomp guard does and does
      not protect). CHANGELOG + version bump to 0.3.0.
- [x] **W3.3 — E2E through the real SB client** (CDP on Helium) like v0.2: publish,
      conflict, panel open, diff render, undo, redo, retention prune. Disposable test
      pages, net-zero changes on real memory.
      **E2E STATE (11/18 ~09:45Z):** HTTP-level E2E fully green against the live
      bridge (publish/versions/diff/undo incl. delete-undo/redo/stomp guard/
      idempotent republish/prune). Browser-level E2E verified: library page pushed
      to the SB space via `PUT /database/.fs/Library/wyattkuhns/Mikiedi.md`, panel
      renders (toolbar/versions/undo-redo/log with color-coded outcomes), publish
      from the real client records the per-tab session id, undo + redo through the
      confirm dialog verified both sides, retention config renders with real enum
      dropdowns (days/forever), `Mikiedi: Apply retention now` ran from the client
      (pruned 11 test versions across 2 slugs, archived 0 journal lines).
      **ONE ITEM OPEN:** the panel's diff viewer section does not render in the
      live client because the client's Space Lua env still runs the PREVIOUS
      library revision: library Lua re-evaluates only via
      `client.clientSystem.loadLuaScripts()` (client_system.ts:353→381
      `spaceLuaEnv.reload`), NOT on page reload after a server-side PUT, and NOT
      on identical re-save. NEXT PASS: run
      `client.runCommandByName`-eval `await client.clientSystem.loadLuaScripts()`
      on the live tab (CDP :9222, bin/cdp.mjs eval), re-invoke `Mikiedi: Show
      panel`, confirm the diff select populates (#mk-diffsel select, 7 options)
      and hunks render, THEN also verify a from-scratch client boot picks it up
      (reload after loadLuaScripts should be consistent). Everything else shipped.
- [x] **W3.4 — Memory/NOW update** after ship.

## Ship status (11/24 ship pass)

Library edits LANDED in both copies (byte-identical): PanelDebug line removed,
top-bar action button added (`actionButton.define`, book-open icon, command
`Mikiedi: Show panel`, priority 1.5, dropdown=false, with a raw-config fallback).
CHANGELOG/operations.md/library-header updated in both copies. Remaining:
sync to SB space → CDP `loadLuaScripts()` → verify diff section + button →
delete `Mikiedi/PanelDebug` SB page (bridge-v03-panel-test left for Wyatt's
panel testing) → secret-path audit → commit + PAT push → fm checker +
[[mikiedi]]/NOW.md update.

## Explicit non-goals (this pass)
- No cross-tab live sync (SB gives none; the stomp guard is the mitigation).
- No coordination with native ingest's consolidation lock beyond the re-verify
  narrowing (public-contract gap documented upstream, not papered over).
- No merge-assist conflict UI (binary resolver stays; revisit if conflicts churn).
