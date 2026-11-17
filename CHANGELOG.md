# Changelog

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
