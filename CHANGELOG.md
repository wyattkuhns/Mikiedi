# Changelog

## 0.3.0 — 2026-11-18

- **Multi-session resiliency.** Cross-process op lock (exclusive lockfile,
  stale-break only for dead holders) alongside the in-process mutex; CAS
  window narrowing (the canonical file is re-hashed immediately before every
  atomic write/delete/resolve, so an external Cadet-side writer racing inside
  the op aborts as a conflict instead of being clobbered); a multi-tab stomp
  guard (a publish from a different editor session within 90s of another
  session's publish returns a `stale-editor` advisory — nothing written,
  refresh first); op failures are now journalled alongside successes.
- **Version history.** Every successful publish/resolve/undo/redo records the
  new state (and a tombstone on delete) into a per-page version store
  (`data/versions/<slug>/`); first write of a page seeds its pre-bridge
  content. Identical republishes dedupe.
- **Undo/redo.** Git-style per-page stacks: undo/redo step the Cadet page
  back/forward through recent states (including restores of deleted pages);
  any new edit clears the redo stack. Undo/redo of deletes restores content
  and re-establishes baselines.
- **Diff engine.** In-house LCS line diff (zero new dependencies) returning
  git-style hunks.
- **Panel diff viewer actually renders in the browser.** SilverBullet serializes
  pure-Lua tables to the panel script in its `arrayPart`/`stringKeys` wrapper
  form; the panel now unwraps that before the numeric-key normalization, so
  the diff selector populates and hunks render with add/del/context coloring.
- **New bridge ops:** `log`, `versions`, `diff`, `undo`, `redo`, `prune`.
- **Retention configuration.** Two independent policies — log retention and
  version retention — each an amount plus a unit (seconds/minutes/hours/
  days/years, or `forever`/`never`). `never` on the log stops recording new
  journal entries (history is kept until a prune; pruned lines are archived
  to `journal-archive.jsonl`, never silently destroyed). `never` on versions
  records no history and disables undo/redo. Pruning is lazy-safe and
  available as an explicit op.
- **SilverBullet panel (`Mikiedi: Show panel`).** Right-hand panel with the
  recent operation log (timestamps, outcomes color-coded, click-through to
  pages), per-page version list, a git-style +/− diff viewer with selectable
  comparisons, undo/redo buttons, and a toolbar: Config (opens Workbench
  Configuration), Help (Mikiedi/Help page, auto-created), Issues (GitHub),
  Info (what Mikiedi is + repo link). Reachable from a dedicated top-bar
  action button (book icon) as well as the command palette. New commands:
  Show panel, Undo current page, Redo current page, Apply retention now,
  Open help.
- **Per-tab session ids.** Each SilverBullet tab gets a session id; the
  bridge uses it for the stomp guard. Retention settings ride on ops from
  the library, so the SilverBullet config is the single source of truth.

## 0.2.1 — 2026-11-17

- Removed the `Mikiedi/Settings` page fallback from the SilverBullet library:
  the Workbench Configuration tab is the standard settings surface going
  forward and the only path the library reads. Docs and setup skill updated to
  match. Existing deployments already configured through the Configuration tab
  are unaffected. If an old `Mikiedi/Settings` page is still in the space, it
  can be deleted — nothing reads it anymore.

## 0.2.0 — 2026-11-17

- Bridge op `fetchAll`: read-only export of the whole memory store
  (content, hash, mtime), no journal entry.
- SilverBullet commands: Pull all pages from Cadet (honors
  `mikiedi.pullExclusions`, never overwrites locally-edited pages), Delete
  page from Cadet (CAS-guarded, two confirmations), Resolve conflict
  (keep-cadet / publish-sb).
- Library settings extras: `mikiedi.autoRefresh`, `mikiedi.pullExclusions`;
  rename warning on publish when the frontmatter slug differs from the page
  name.

## 0.1.0 — 2026-11-16

First release.

- Cadet plugin `mikiedi` (TypeScript): single bearer-verified ingress route dispatching ops
  (`status`, `pages`, `page`, `validate`, `publish`, `delete`, `adopt`, `resolve`, `sync`, `refresh`).
- Conflict model per `docs/conflict-model.md`: full-byte SHA-256 CAS against recorded
  baselines, explicit adoption, verbatim conflict preservation, keep-cadet override guard,
  CAS-guarded deletion, per-page pre-image snapshots, append-only JSONL journal.
- Retrieval refresh via the documented `assistant memory v3 rebuild-index` command with an
  honest `pendingRefresh` fallback.
- SilverBullet library (Space Lua): publish (current page + picker), refresh, status page,
  adopt, frontmatter scaffolding, Configuration Manager settings.
- Setup and operations skills for the assistant.
- 25 unit tests over the op engine (`bun test`).
