# Security

## Data flow and exposure

- The only public surface is `/webhooks/plugins/mikiedi/bridge` — one POST route, bearer-verified by the gateway before the plugin sees anything. Unauthenticated probes get 404 (no route-name oracle).
- The plugin reads and writes only `memory/concepts/` and its own `data/`. It never calls the model, never reads credentials other than (indirectly) the ingress secret the gateway already verified.
- Pages published from SilverBullet travel to the assistant box by definition — publishing is the feature. **Never publish memory pages that contain secrets.** The validator's job is schema integrity, not secret scanning.

## Token handling

- Generated token → `assistant credentials prompt` (service `mikiedi`, field `bridge_token`). Never in chat, never in a URL (Cadet accepts bearer credentials only in the `Authorization` header), never in `ingress.json`.
- The same value lives in SilverBullet's Configuration Manager (masked). Anyone with page-edit rights in the space can read it — the same trust level as being able to publish. If that boundary is too wide for a space, don't install the library in it.
- Static bearer tokens have no replay protection (per Cadet's channel docs). Prefer rotating after any suspected disclosure; rotation is a two-step update (vault + SilverBullet config).

## Recovery bundle hygiene

The plugin `data/` directory contains page snapshots and conflict artifacts — memory content. If you archive it (e.g. before uninstall), store it with the same care as the memory itself and never commit it to this repo.
