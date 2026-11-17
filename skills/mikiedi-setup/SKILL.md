---
name: "Mikiedi bridge setup"
description: "Install and configure the Mikiedi (Memory Wiki Editor) bridge: the Cadet plugin side, its ingress credential, guardian approval, and the SilverBullet library side. Run once per assistant + SilverBullet pair."
metadata:
  vellum:
    activation-hints:
      - setting up the SilverBullet to Cadet memory bridge or the Mikiedi plugin
      - Mikiedi commands report that the bridge URL or token is not configured
      - a newly installed plugin's ingress route is pending guardian approval
    category: memory
---

# Mikiedi bridge setup

Mikiedi publishes SilverBullet pages into Cadet memory through a plugin
(`mikiedi`) whose single public ingress route (`/webhooks/plugins/mikiedi/bridge`)
is verified by the gateway with a static bearer token. Full background:
the repo README and `docs/architecture.md`.

## Prerequisites

- Cadet assistant running (self-hosted), with the workspace that holds `memory/concepts/`.
- A SilverBullet instance whose editor users are trusted (they can publish into memory).

## Steps

1. **Install the plugin.**
   - From the repo: `assistant plugins install https://github.com/wyattkuhns/Mikiedi`
     (or copy the repo contents to `<workspace>/plugins/mikiedi/`).
   - Verify: `assistant plugins list` shows `mikiedi`.

2. **Store the ingress bearer token.** Generate a random token (e.g.
   `openssl rand -hex 32`) and store it under the plugin's service name with
   the exact field the ingress declaration names:
   - Run `assistant credentials prompt` with service `mikiedi`, field
     `bridge_token`, and paste the generated value. Never paste secrets into chat.
   - The gateway refuses to serve the route while this secret is missing.

3. **Approve the ingress (guardian action).** The plugin's ingress
   declaration is pending until a guardian approves its digest in
   **Settings → Channels**. Until then the public route 404s. The user
   must do this; a plugin must not approve its own ingress.

4. **(Optional) config.json.** Defaults are correct for a standard install
   (`<workspace>/memory/concepts`, CLI binary `assistant`). Only create
   `<plugin>/config.json` to override:
   ```json
   { "conceptsDir": "/absolute/path", "cliPath": "cadet", "refreshTimeoutMs": 30000 }
   ```
   For a **disposable-corpus test run**, point `conceptsDir` at a scratch
   directory and set `cliPath` to `/bin/false` so nothing touches live memory.

5. **Install the SilverBullet library.** Copy
   `library/Library/wyattkuhns/Mikiedi.md` from the repo into the space at the
   same path (or install via the Library mechanism), then run **System: Reload**
   (Ctrl-Alt-r) in SilverBullet.

6. **Configure the library.** Create a `Mikiedi/Settings` page in the space with two
   lines — `bridgeUrl:` (the full public bridge URL, e.g.
   `https://your-assistant.example.com/webhooks/plugins/mikiedi/bridge`) and
   `bridgeToken:` (the same value stored in step 2). On SB builds that have a
   Configuration Manager, the same values can be set under Configuration → Mikiedi
   instead; the settings page always wins when filled in. (The Configuration
   Manager API postdates some deployed builds — a pinned 2.12.0-edge image has
   no Configuration Manager at all, which is why the page is the universal path.)

7. **Verify on a disposable page.**
   - In SilverBullet, create a page named like `mikiedi-test-page` with a
     small body, run `Mikiedi: Publish current page`, and accept the
     frontmatter scaffold if offered.
   - On the Cadet box confirm the file exists under `memory/concepts/` (or
     the test `conceptsDir`), then delete the page through SilverBullet
     (delete in the space, then `Mikiedi: Refresh from Cadet` on it to see
     the deleted-in-Cadet verdict, or use the bridge `delete` op).
   - Run `Mikiedi: Status` and confirm the page lists the publish and the
     journal tail.

## First real adoption

When connecting a bridge to an existing memory store for the first time, run
**Mikiedi: Adopt Cadet state** once: it records baselines for every existing
page without modifying anything. Until a page has a baseline, publishing to
it returns `adopt-required` instead of writing.

## Troubleshooting

- **Public URL 404s** → ingress not approved yet (step 3), secret missing
  (step 2), or the plugin is disabled.
- **401 from the bridge** → token mismatch: the value in SilverBullet must
  equal the credential `mikiedi/bridge_token` exactly.
- **`adopt-required` on every publish** → expected before the first adopt.
- **`pendingRefresh` in status** → the CLI refresh subprocess failed; run
  `assistant memory v3 rebuild-index` manually on the Cadet box.
- **Lua errors on first use** → run `System: Reload` after installing the
  library; check the browser console for the exact failing line.
