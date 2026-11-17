# Architecture

## The problem

Cadet's memory is a wiki of concept pages (`<workspace>/memory/concepts/<slug>.md`) with frontmatter (`title`, `slug`, `tags`, `links`, …), a link graph over slugs, and retrieval machinery (page index + section-lane embedding) that expects pages to obey slug and schema rules. SilverBullet is a great Markdown editor but knows nothing about those rules, and its edits land on disk with no schema gate.

The bridge therefore has three jobs: **validate** what SilverBullet wants to publish, **guard** every write against concurrent change, and **refresh** retrieval state afterwards — while keeping an auditable trail so every action is reversible.

## Three layers

```
┌────────────────────────────┐
│ SilverBullet (browser)     │
│  Space Lua library         │  commands: publish / refresh / status / adopt
│  config.define settings    │  bridge URL + bearer token
└─────────────┬──────────────┘
              │ POST /webhooks/plugins/mikiedi/bridge
              │ Authorization: Bearer <token>   (verified by the gateway)
┌─────────────▼──────────────┐
│ Cadet gateway (edge)       │  ingress declaration in channels/ingress.json
└─────────────┬──────────────┘
              │ forwards to /x/plugins/mikiedi/bridge
┌─────────────▼──────────────┐
│ Cadet plugin (mikiedi)     │
│  routes/bridge.ts          │  thin HTTP adapter
│  src/ops.ts                │  op engine: validate → CAS → snapshot → write → journal
│  src/refresh.ts            │  spawns `assistant memory v3 rebuild-index`
│  data/ (private)           │  state.json, journal.jsonl, snapshots/, conflicts/
└─────────────┬──────────────┘
              ▼
   <workspace>/memory/concepts/*.md   ← the canonical store
   retrieval index ← rebuild-index invalidation
```

## Design decisions and why

- **Cadet keeps the canonical store; SilverBullet holds an editable copy.** No live mount of memory into the SB space, so there is no two-master filesystem and no background sync daemon. Movement between the two sides is always an explicit, logged operation.
- **Publication is push-based (editor → bridge over HTTP)** rather than filesystem watching. It keeps the plugin portable across Cadet installations (no assumptions about how SB is deployed or where its volume lives) and makes every publication an intentional act.
- **Pull/reconciliation (Cadet → editor) is verdict-based.** The `sync` op returns one of `current`, `update`, `publish-from-editor`, `deleted-in-cadet`, or `conflict`; the editor applies the safe ones and surfaces the rest to a human. Cadet-originated changes only flow into the editor when the editor's copy provably still matches the recorded baseline.
- **One ingress route, op-dispatched.** Every public route a plugin declares is guardian-approved in Cadet; a single `bridge` route keeps the approval surface minimal and lets the protocol evolve without re-approval.
- **The op engine is a pure library** (`src/ops.ts`) with injected dependencies (dirs, clock, refresh), so the whole conflict model is unit-tested without a Cadet runtime; the HTTP route is a thin adapter.
- **Refresh uses the documented CLI command** (`assistant memory v3 rebuild-index`) as a subprocess rather than undocumented daemon internals. If it cannot run, publication stays valid and `pendingRefresh` is reported honestly in every status response.
- **Why not Cadet's native `memory ingest` for publication?** Verified from the runtime: ingest holds the consolidation lock and validates, but exposes no compare-and-swap field and no delete/rename semantics. The bridge needs CAS + delete to honor its conflict model, so it performs guarded out-of-band writes — a scenario Cadet's own `rebuild-index` command explicitly exists to support ("after editing concept pages out-of-band") — and lets Cadet's validator remain the final authority on schema rules.

## Trust model

- Anyone who can edit pages in the SilverBullet space can publish into memory — the editor is inside the trust boundary by definition. The bridge's value is not restricting trusted users; it is making their mistakes *visible, preserved, and reversible* instead of silently destructive.
- The bearer token lives in SilverBullet's Configuration Manager and in Cadet's credential vault (`mikiedi/bridge_token`). It authenticates the space, not a person. See [security.md](security.md).

## What the bridge deliberately does NOT do (v0.1)

- No automatic publication or background polling/sync — every transfer is user-initiated.
- No slug migrations: renaming a page in SilverBullet changes its Cadet slug, which is identity-level damage (inbound links, edges). Renames are a documented manual procedure in [operations.md](operations.md).
- No cross-writer locking against Cadet's own writers; the CAS window is documented in [conflict-model.md](conflict-model.md).
- No reads/writes outside `memory/concepts/` and the plugin's own `data/` directory.
