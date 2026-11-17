# Compatibility

## Tested

| Component | Version | What was tested |
| --- | --- | --- |
| Cadet assistant | 0.13.0 (self-hosted, source-verified) | plugin loader manifest rules, route dispatch, ingress bearer verification, `memory v3 rebuild-index` CLI |
| Op engine | this repo | `bun test` — 25 unit tests over the full conflict model (publish/adopt/conflict/resolve/delete/sync/refresh) against real temp-disk stores |
| SilverBullet | 2.x docs-verified APIs | `space.*`, `editor.*`, `config.define/get`, `net.proxyFetch` (auto-JSON both directions), `command.define` |

## Known gaps and caveats — stated, not hidden

- **The Space Lua commands are verified against the documented API surface, not yet against a live browser session.** First-run verification (one publish on a disposable page) is part of the install checklist. The bridge side (everything behind the HTTP route) is fully tested; the Lua side is thin by design and its syscalls are all documented SB 2.x APIs.
- **`@mycadet/plugin-api` vs `@cadetai/plugin-api`:** the public docs use the `@cadetai` name; the installed 0.13.0 runtime enforces `@mycadet/plugin-api` as the peer dependency. This repo declares the runtime-checked name (that is what the loader verifies) and the code never imports the package — it uses the documented environment variable for workspace resolution — so the docs/runtime naming gap cannot break the plugin.
- **Host layouts:** tested pattern is Cadet self-hosted on Linux with SilverBullet on the same host or reachable over HTTPS. Cadet Cloud hosting is untested (plugin ingress availability there is a platform question).
- **Body size limits:** the gateway enforces request-body limits; publish one page per request (the default flow does) rather than batching a whole space.
