# Mikiedi — Memory Wiki Editor

Mikiedi is a **bridge between [SilverBullet](https://silverbullet.md) and [Cadet](https://www.mycadet.ai) memory**: it lets you view and edit an assistant's concept-page memory wiki in SilverBullet's editor, then publish changes back through a validated, revision-guarded, fully journaled pipeline.

It is built entirely from each platform's supported extension surfaces:

- **Cadet side: a plugin in TypeScript** — one public ingress route (bearer-verified by the Cadet gateway), backed by an operation engine that enforces the [conflict model](docs/conflict-model.md): full-byte SHA-256 CAS against the canonical store, per-page pre-image snapshots, an append-only journal, atomic writes, and explicit-only conflict resolution.
- **SilverBullet side: a standard Library in Space Lua** — commands for publish, refresh, status, and adoption, configured through SilverBullet's Configuration Manager.

Nothing is mounted live, nothing is auto-merged, and no writes happen without a journal entry and a snapshot of what they replaced.

## Quick start

1. **Cadet:** `assistant plugins install https://github.com/wyattkuhns/Mikiedi`
2. **Credential:** store a generated token as `mikiedi/bridge_token` (see [`docs/install.md`](docs/install.md) — collected via `assistant credentials prompt`, never in chat).
3. **Approve:** the guardian approves the pending ingress in Settings → Channels.
4. **SilverBullet:** copy `library/Library/wyattkuhns/Mikiedi.md` into your space, reload, and fill in **Configuration → Mikiedi** (bridge URL + token).
5. **Adopt:** run `Mikiedi: Adopt Cadet state` once to baseline the existing memory store.
6. **Test on a disposable page first.** Full walkthrough: [`docs/install.md`](docs/install.md).

## How a publish works

```
SilverBullet page ──POST /webhooks/plugins/mikiedi/bridge──▶ gateway verifies bearer
    ▶ plugin route (routes/bridge.ts)
    ▶ op engine (src/ops.ts), under the cross-process op lock + in-process mutex:
         validate slug + conservative frontmatter check
         CAS: canonical hash == recorded baseline (and == editor-declared baseHash);
              canonical re-hashed immediately before the write (external-writer race aborts)
         multi-tab guard: publish from another session inside the window → stale-editor advisory
         conflict? → preserve BOTH versions in data/conflicts/, write nothing
         safe? → snapshot pre-image → version recorded → atomic write → journal → index refresh
    ◀ per-page result: published | adopt-required | conflict | stale-editor | error
```

Version history (per-page, with undo/redo, git-style diffs in the
SilverBullet panel) and the two retention policies (log vs versions, each
seconds/minutes/hours/days/years or forever/never) are documented in
[`docs/operations.md`](docs/operations.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `package.json`, `channels/ingress.json`, `routes/`, `src/`, `skills/` | The Cadet plugin (the repo root **is** the plugin) |
| `library/Library/wyattkuhns/Mikiedi.md` | The SilverBullet library page (Space Lua) |
| `test/` | Bun unit tests for the op engine (`bun test`) |
| `docs/` | Architecture, conflict model, install, operations, compatibility, security |

## Documentation

- [docs/architecture.md](docs/architecture.md) — the three-layer design and data flow
- [docs/conflict-model.md](docs/conflict-model.md) — CAS, baselines, adopt, conflicts, resolutions
- [docs/install.md](docs/install.md) — both sides, verification, disposable-corpus testing
- [docs/operations.md](docs/operations.md) — status meanings, recovery, limitations
- [docs/compatibility.md](docs/compatibility.md) — tested versions and known gaps

## License

Apache-2.0. Memory pages, snapshots, and tokens never belong in this repo — see [docs/security.md](docs/security.md).
