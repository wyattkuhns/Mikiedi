# Changelog

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
