# Conflict model

The conflict model is the contract that makes external editing of a canonical store safe. Everything the bridge does follows from these rules.

## Identity and revisions

- A page's **slug** (its path under `memory/concepts/`, minus `.md`) is Cadet's identity for it: link graph, retrieval state, and cross-references key on it. The bridge never renames silently; slugs must be valid before anything else happens.
- A revision is the **full-byte SHA-256 of the page file** — frontmatter included. Metadata-only edits therefore count as changes. mtime is never trusted.
- For each slug the bridge records a **baseline**: the hash of the canonical page at the moment the editor last provably saw it. Baselines are created by `adopt` (explicit, never overwrites anything) and updated by successful publishes and resolutions.

## The CAS rule

A publish is accepted only when **all** of these hold:

1. The page passes validation (slug rules; conservative frontmatter check; non-empty body; `slug:` key matches the filename if present).
2. No unresolved conflict is recorded for the slug.
3. The canonical file's hash equals the recorded baseline hash (Cadet has not changed since the editor's last sync).
4. If the request carries a `baseHash` (what the editor believed it was editing), it also equals the canonical hash.

If any check fails, **nothing is written**. Instead the bridge preserves both versions verbatim in `data/conflicts/<slug>/<timestamp>/` (`silverbullet.md`, `cadet.md`, `meta.json`), records the conflict in state and journal, and returns the Cadet content to the editor so a human can see both.

## Explicit adoption

When a page exists in Cadet but the bridge has no baseline for it (first contact with an existing store, or state lost), publishing returns `adopt-required` — it never overwrites an unseen page. `adopt` records baselines from current canonical content and **changes no pages**.

## Conflict resolution — never automatic

Conflicts end only by explicit choice, against the displayed current revision:

- **keep-cadet** — canonical stays; the editor must refresh before publishing again. While this resolution is in effect, a stale editor copy is *blocked* from republishing over the kept version (the guard clears only after the editor provably holds the kept version). This is what prevents a stale browser from silently undoing a resolution.
- **publish-sb** — the editor's version wins, explicitly, against the displayed revision; the pre-image is snapshotted first.
- Re-publishing after editing the editor copy simply creates a fresh conflict that gets resolved the same way.

## Deletion

Deletion is a separate explicit operation with its own CAS: the request must carry the exact current hash of the page. The pre-image is snapshotted, a tombstone is recorded, and the editor is told on next `sync` (`deleted-in-cadet`). Zero-byte pages are rejected by validation — the "deleted" state from SilverBullet's UI (an empty file) is data, not a deletion, and the bridge treats it as an invalid page.

## The documented race window

The CAS read and the atomic write are not one atomic transaction against Cadet's own writers (consolidation passes, memory tools). A write by another writer inside that window would be overwritten by the bridge's rename. The window is milliseconds and every bridge write is snapshotted, but the operating agreement is: **don't edit the same page in the editor while Cadet-side automation is writing it.** True cross-writer CAS would need an upstream platform primitive (a conditional-write field in native ingest); the bridge documents this gap instead of pretending it away.

## What every operation leaves behind

| Operation | Canonical change | Snapshot | Journal entry | State change |
| --- | --- | --- | --- | --- |
| `publish` (accepted) | atomic write | pre-image (if replacing) | yes | baseline updated |
| `publish` (conflict) | **none** | — | yes | conflict recorded |
| `delete` (accepted) | file removed | pre-image | yes | tombstone |
| `adopt` | **none** | — | yes | baselines recorded |
| `resolve` | per action | pre-image on publish-sb | yes | conflict cleared / marker set |
| `sync` | **none** | — | only on new conflict | maybe conflict recorded |
| `refresh` | **none** | — | — | refresh state |
