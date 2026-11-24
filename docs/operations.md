# Operations

Every bridge operation is observable. State lives in `<workspace>/plugins/mikiedi/data/`:

| Path | Contents |
| --- | --- |
| `state.json` | Baselines, conflicts, tombstones, keep-cadet markers, refresh state, undo/redo stacks, recent-publish sessions |
| `journal.jsonl` | Append-only audit trail; newest entry last |
| `journal-archive.jsonl` | Journal lines moved out by log-retention pruning (never destroyed) |
| `snapshots/<slug>/<ts>-<hash>.md` | Pre-image of every replaced or deleted page |
| `conflicts/<slug>/<ts>/` | `silverbullet.md` + `cadet.md` + `meta.json` per conflict |
| `versions/<slug-dir>/` | Version history: `index.json` plus the full content of every recorded state (v0.3) |

## Status vocabulary

| Result | Meaning | What to do |
| --- | --- | --- |
| `published` | Validated, CAS passed, written atomically | Nothing |
| `adopt-required` | Page exists in Cadet, no baseline | Run Adopt (per page or all) |
| `conflict` | Canonical ≠ baseline (or baseHash mismatch); both versions preserved | Resolve explicitly (below) |
| `stale-editor` | Another editor session published this page within the stomp window; nothing written | Refresh from Cadet, then publish again if the edit still applies |
| `error` | Validation failed; `issues[]` is specific | Fix the page, republish |
| `pendingRefresh: true` | Pages written; index-refresh subprocess failed | `assistant memory v3 rebuild-index`, then `refresh` op |

`Mikiedi: Status` in SilverBullet renders all of this (including the journal tail) into `Mikiedi/Status`.

## Version history, undo/redo, and retention (v0.3)

Every successful publish, resolve, undo, and redo records the new page state in the version store; deletes record tombstones. The first bridge write of a page also seeds its pre-bridge content, so history reaches back before the bridge. Identical republishes record nothing. Two undo/redo stacks per page (git semantics: any new edit clears redo) let `Mikiedi: Undo current page` / `Redo current page` step the Cadet copy back and forward through recent states — including restoring a deleted page. Restores are themselves recorded, journaled, and CAS-guarded.

Retention is configured in SilverBullet (Workbench → Configuration → Mikiedi) and sent with each op:

| Setting | Default | Meaning |
| --- | --- | --- |
| Log retention: amount + unit | 30 days | Journal lifetime; pruning MOVES expired lines to `journal-archive.jsonl` |
| Log retention unit: forever / never | days | `forever` keeps everything; `never` stops recording new journal entries (recovery history is disabled) |
| Version retention: amount + unit | 90 forever | Version store lifetime; pruning removes expired version content for good |
| Version retention unit: forever / never | forever | `never` records no versions at all — undo/redo become unavailable |

Units: seconds, minutes, hours, days, years (365.25-day years). `Mikiedi: Apply retention now` prunes both categories on demand; the prune op reports exactly what was archived/removed. The panel also gets a top-bar action button (book icon, via the standard `actionButtons` config), so it opens without the command palette.

## Resolving conflicts

1. **Keep Cadet's version** — run **Mikiedi: Resolve conflict** and choose "Keep Cadet's version" (this also pulls Cadet's copy into the space and clears the conflict page), or op `resolve` with `action: "keep-cadet"`. The editor must then refresh before publishing again; the guard is automatic.
2. **Keep the editor's version** — run **Mikiedi: Resolve conflict** and choose "Publish this space's version", or edit the SilverBullet copy to the intended final state and publish again (a fresh conflict is recorded and resolved), or op `resolve` with `action: "publish-sb"` and the resolved content.

## Recovery

- **Roll back one page:** take the newest file in `data/snapshots/<slug>/`, verify against the journal what it preceded, restore with a guarded write, refresh the index.
- **`state.json` lost:** safe to start empty — every page will report `adopt-required` until a fresh Adopt pass. Baselines only guard the editor's view; no canonical data lives in them.
- **Journal is the intent record:** if you need to reconstruct what happened, read `journal.jsonl` newest-last. Each line names op, slug, outcome, previous and new hash.
- **Before uninstalling the plugin**, archive `data/` — uninstall deletes it.

## Pulling memory into SilverBullet (v0.2)

**Mikiedi: Pull all pages from Cadet** fetches the whole store into the space under the pages' real slugs — this is the "import existing memory" step. Behavior:

- Pages that don't exist in the space yet are written as-is.
- Pages that exist in the space with different content are **never overwritten silently**; they are listed in the `Mikiedi/Pull` report. Use **Mikiedi: Refresh from Cadet** per page to force an overwrite.
- Slugs can be excluded with the **Pull exclusions** setting (comma-separated exact slugs or prefixes).
- A prefix-mapped mode (pages landing under a configurable namespace, e.g. `Memory/…`, for SilverBullet instances used for other things too) is a **planned** option — not implemented in v0.2; real slugs are the current contract.

## Settings (Workbench → Configuration → Mikiedi)

| Setting | Default | Meaning |
| --- | --- | --- |
| Bridge URL | — | Full URL of the bridge ingress route |
| Bridge token | — | Bearer token stored on the Cadet side |
| Auto-refresh retrieval index | on | Publish/delete also invalidates Cadet's retrieval index |
| Pull exclusions | empty | Slugs/prefixes `Pull all pages from Cadet` skips |

## Renames and folder moves (v0.1 limitation)

A rename in SilverBullet changes the slug, and the slug is Cadet's identity for the page: inbound links, link-graph edges, and retrieval state reference it. The bridge does **not** auto-migrate. To move a page:

1. `delete` the old slug through the bridge (CAS-guarded, snapshotted).
2. Publish under the new slug.
3. Fix inbound references in the affected pages (search the corpus for `[[old-slug` and for the slug in `links:` frontmatter). This is a separate, reviewed edit — ideally by the assistant, which can see the link graph.

## The refresh path

Publication writes files; retrieval needs its index invalidated. The bridge spawns the documented CLI command (`assistant memory v3 rebuild-index`) with the workspace environment set. If that fails (CLI not on PATH, timeout, non-zero exit), the bridge says so: `pendingRefresh` shows in every status until a successful `refresh` op or manual run. Pages are never lost because of a refresh failure — retrieval just may lag until the rebuild.

## Operating agreement

- Don't edit the same page in SilverBullet while Cadet-side automation (consolidation, memory tools) is writing it — the CAS window is small but real ([conflict-model.md](conflict-model.md)).
- Rotate the `mikiedi/bridge_token` credential after any suspected disclosure (static bearer = no replay protection, per Cadet's own docs).
- When testing, use a disposable `conceptsDir` in `config.json` — then remove the override.
