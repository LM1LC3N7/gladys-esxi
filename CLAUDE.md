# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for VMware ESXi hosts and vCenter:
a Node.js service (Node 22+, ESM, no build step) that runs in its own
sandboxed Docker container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It reads the hosts, datastores and VMs through
the vSphere Web Services API (SOAP, the calls written by hand after pyVmomi,
Apache-2.0), and offers three VM buttons (Start, Shut down, Restart), each
off by default. See `TODO.md` for the status and every decision.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "Start"   # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # regenerate cover.png (plain Node)
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js)
src/handlers.js                   every SDK handler, registered before connect()
src/app.js                        EsxiApp: start queue, loop, attempts, failures, states, VM actions
src/vsphere/client.js             the SOAP calls: service content, login, properties, VM actions
src/vsphere/http.js               the only network access (HTTPS pinned, no redirect, bounded)
src/vsphere/soap.js               envelopes, answers, faults (by type), property values
src/vsphere/xml.js                a small linear XML parser (no DOCTYPE, bounded)
src/vsphere/parse.js              the property paths read, objects -> hosts, datastores, VMs
src/vsphere/errors.js             error codes; the fault types told apart
src/devices.js                    host, datastore and VM devices (pure), never fewer features
src/config.js                     DEFAULTS (mirror the manifest) + normalization
src/store.js                      /data: refusal HMAC, salt, pins, pauses, attempts, cooldowns
src/budget.js                     sliding window of the states sent per minute (reserved)
src/i18n.js                       statuses and messages (en / fr)
gladys-assistant-integration.json manifest
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, fake Gladys (SDK) + fake vSphere + loopback TLS
```

## Rules

- **External ids are forever**: `host:<moref>`, `datastore:<moref>`,
  `vm:<instance uuid>` and the feature keys of `src/constants.js`. Changing
  one creates a new device and orphans the old one. The same goes for every
  key users store: manifest `config_schema` and `actions`.
- **VM actions** are `button`/`push`, never a switch nor a binary, each
  refused unless its option is on; the VM is read again (same instance UUID,
  its power state) just before, the option and the deadline checked again
  right before the request is written (`beforeSend`), never retried, never
  preceded by a login, one per VM per minute (kept in `/data`). Only
  `PowerOnVM_Task`, `ShutdownGuest` and `RebootGuest`: never a host action,
  never a hard power off or reset (`test/soap.test.js` checks the source).
  Any new command needs Louis's decision, off by default, never a switch.
- **Secrets**: the password and the session cookie are never in a log, an
  error message, a status, a state or `/data`; the text of a SOAP fault is
  never kept (it may quote names), only its type. VM names never go to the
  logs. `test/app.test.js` checks it.
- **HTTPS**: the certificate is pinned (typed, or learned by a request that
  carries no secret) and checked before any byte is written; the password
  only travels on a pinned connection (`secret: true`). Never turn it off.
  A changed certificate is never accepted by a save nor re-learned: only by
  its fingerprint typed, or the "Trust the new certificate" action, which
  pins exactly the fingerprint shown in the status.
- **Never faster than the interval**: the last attempt is kept in memory and
  in `/data` (at most one write a minute); a restart, a reconnection, the
  test button, the scan and an unchanged configuration all wait for it.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (0.1.0 was set by hand once, before the first release).
  `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are `{ "en": ..., "fr": ... }` objects; the catalog
  `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code. A secret field is
  described as kept by Gladys in its database, never shown again; never as
  protected by any cipher (the test refuses it).
- **Units**: only those the core lists for the category
  (`DEVICE_FEATURE_UNITS_BY_CATEGORY`); no percent for a processor or a
  disk in the core: `unknown`/`unknown`, the unit in the feature name.
- **Encoding.** Files are UTF-8 without BOM nor control bytes;
  `test/encoding.test.js` refuses mojibake. Write files with an editor,
  never through a shell that guesses a code page.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback only).
