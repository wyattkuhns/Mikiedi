# Installation

Two installs, in this order: the Cadet plugin, then the SilverBullet library.

## 1. Cadet plugin

```bash
assistant plugins install https://github.com/wyattkuhns/Mikiedi
assistant plugins list        # should show mikiedi
```

(Or clone the repo and copy its contents to `<workspace>/plugins/mikiedi/`.)

### Ingress credential

The plugin declares one public route (`bridge`) verified by a static bearer token. Generate one and store it in the Cadet credential vault under the plugin's service name:

```bash
openssl rand -hex 32          # generate a token; keep it off the clipboard trail you don't control
assistant credentials prompt  # service: mikiedi  field: bridge_token
```

Never put the token in `ingress.json`, chat, or a URL — Cadet accepts bearer credentials only in the `Authorization` header.

### Guardian approval

The gateway serves the route only after a guardian approves the ingress declaration digest: **Settings → Channels** in the Cadet web client. Until then the public URL answers 404 (by design, so probes learn nothing).

### Optional config

Create `<workspace>/plugins/mikiedi/config.json` only to override defaults:

```json
{ "conceptsDir": "/absolute/path/to/concepts", "cliPath": "assistant", "refreshTimeoutMs": 30000 }
```

Defaults: `conceptsDir` = `<workspace>/memory/concepts`, `cliPath` = `assistant`.

> **Disposable-corpus testing:** set `conceptsDir` to a scratch directory and
> `cliPath` to `/bin/false` first. Nothing then touches live memory, and the
> pending-refresh path gets exercised on purpose. Remove `config.json` afterwards.

## 2. SilverBullet library

Copy `library/Library/wyattkuhns/Mikiedi.md` from the repo into the space at the same path (or install it via SilverBullet's Library mechanism from the repo URL). The `name` frontmatter key must match the page's full path — if you place it under a different owner directory, update that key.

Then run **System: Reload** (Ctrl-Alt-r) so the Space Lua definitions load, and open **Configuration → Mikiedi**:

- **Bridge URL** — the full public bridge URL, e.g. `https://your-assistant.example.com/webhooks/plugins/mikiedi/bridge`
- **Bridge token** — the value stored in step 1. It is a masked field. Whoever can edit the space can read it (it is the editor's own credential); that is the intended trust boundary.

## 3. First contact: adopt

Run **Mikiedi: Adopt Cadet state** once. It records a baseline for every existing page **without modifying anything**. Until then, publishing to an existing page returns `adopt-required` instead of writing — that is the guard working.

## 4. Verify on a disposable page

1. Create a page named `mikiedi-test-page` in SilverBullet, type a sentence, run **Mikiedi: Publish current page**, accept the frontmatter scaffold if offered.
2. Expected: "Published mikiedi-test-page to Cadet memory."
3. On the Cadet box: the file exists under `memory/concepts/`; `Mikiedi: Status` shows the page and a journal line.
4. Edit it, publish again; then edit the file directly on disk (simulating a Cadet-side change) and publish again → expect a **conflict** and a conflict page in `Mikiedi/Conflicts/…`. Resolve with **Mikiedi: Refresh from Cadet**.
5. Delete the test page via the bridge `delete` op (or ask the assistant), then run **Mikiedi: Refresh from Cadet** on the SB copy → expect `deleted-in-cadet`.

## Uninstall / upgrade

- **Upgrade:** reinstall over the existing plugin; `config.json` and `data/` survive upgrades.
- **Uninstall:** Cadet deletes the plugin's `data/` directory. If the snapshots/journal still matter, archive `data/` **first**. See [operations.md](operations.md).
