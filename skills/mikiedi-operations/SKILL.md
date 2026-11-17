---
name: "Mikiedi bridge operations"
description: "Day-2 operations for the Mikiedi memory bridge: reading status, resolving conflicts, recovery from snapshots and the journal, handling refresh-pending, renames, and clean uninstall with a recovery bundle."
metadata:
  vellum:
    activation-hints:
      - a Mikiedi publish or sync returned conflict, adopt-required, or pendingRefresh
      - recovering or rolling back a page published through the Mikiedi bridge
      - uninstalling or upgrading the Mikiedi plugin safely
    category: memory
---

# Mikiedi bridge operations

State lives in the plugin's data directory `<workspace>/plugins/mikiedi/data/`:

| Path | Contents |
| --- | --- |
| `state.json` | Baselines, conflicts, deletion tombstones, refresh state |
| `journal.jsonl` | Append-only audit trail, one JSON line per operation |
| `snapshots/<slug>/<ts>-<hash>.md` | Pre-image of every replaced or deleted page |
| `conflicts/<slug>/<ts>/` | `silverbullet.md`, `cadet.md`, `meta.json` per conflict |

## Status meanings

- `published` — validated, CAS passed, written atomically, journal entry added.
- `adopt-required` — page exists in Cadet but has no baseline; run Adopt.
- `conflict` — canonical changed vs baseline (or baseHash mismatch). Both
  versions preserved in `data/conflicts/...`; nothing was written.
- `error` — validation failure; `issues[]` says exactly what to fix.
- `pendingRefresh: true` — pages were written but the retrieval-index
  invalidation subprocess failed. Run `assistant memory v3 rebuild-index`
  on the Cadet box, then call the `refresh` op (or ignore; the next manual
  rebuild clears it).

## Conflict resolution

Resolve explicitly, never silently:

1. **Keep Cadet's version**: op `resolve` with `action: "keep-cadet"`, or in
   SilverBullet accept the refresh from `Mikiedi: Refresh from Cadet`.
   While a keep-cadet resolution is in effect, a stale editor copy is
   blocked from republishing over it (it must refresh first).
2. **Keep the editor's version**: fix the copy in SilverBullet, publish again
   (a fresh conflict is recorded and then resolved), or op `resolve` with
   `action: "publish-sb"` and the resolved content.

## Recovery

- **Single page rollback**: the newest file in `data/snapshots/<slug>/` is the
  pre-image of the last bridge write. Restore it with a guarded write and
  refresh the index. Never restore blindly over newer edits — check the
  journal first (`journal.jsonl`, newest last).
- **Reconstruct intent**: the journal is the ordered record of every
  operation with hashes; replay from it if `state.json` is ever lost
  (baselines can be re-derived by adopting the current store).
- **state.json lost**: safe to start empty; every page will report
  `adopt-required` until a new Adopt pass. Nothing canonical is lost —
  state only guards the *editor's* view.
- **Plugin uninstall deletes `data/`**: export a recovery bundle (tar the
  data directory) BEFORE uninstalling, if the snapshots/journal still matter.

## Known v0.1 limitations (do not paper over)

- **Renames/folder moves change the slug** — Cadet identity for a page is
  its slug; the bridge does not auto-rewrite inbound references. To move a
  page: delete with CAS, publish under the new slug, then fix references in
  the affected pages (the bridge reports inbound `[[links]]` in the docs;
  link fixing is a separate, reviewed edit).
- **Races with other Cadet writers** (consolidation, memory tools) are
  narrowed by the CAS check but not eliminated: a write between the CAS
  read and the atomic rename would still win. The window is small and every
  bridge write is snapshotted, but concurrent edits to the SAME page should
  be avoided by agreement.
- **The validator is a conservative YAML subset** — block scalars, anchors,
  tabs, and exotic quoting are rejected with specific messages rather than
  mis-parsed. If a page legitimately needs full YAML, extend the validator
  with tests rather than loosening it silently.
- **Static bearer token has no replay protection** (per Cadet docs). Rotate
  the `mikiedi/bridge_token` credential after any suspected disclosure.
