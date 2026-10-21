# TODO — VMware ESXi v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own: the claim is in /t/10385 (lot 12).

## Status

- [x] **Milestone 1 — core** (2026-10-21): the vSphere Web Services API
      (SOAP vim25) written by hand after pyVmomi 9.1.1.0: service content,
      login, one paged RetrievePropertiesEx from the root folder (hosts,
      datastores, VMs), logout at a stop; one device per host, datastore and
      VM; Start, Shut down (guest) and Restart (guest) buttons off by
      default; certificate pinned before any secret; credentials refusal
      final and remembered; 429 / 5xx pause bounded and persisted; the last
      attempt kept in `/data` (never faster than the interval, a container
      restart included); status and Discovery sent again at every
      `connected`; a published device never loses a feature; docs en/fr.
      Tested with unit tests against the SDK's fake Gladys, a fake vSphere
      server and loopback HTTPS servers (a self-signed certificate made in
      Node). **Never tested with a real ESXi host nor vCenter.** No Docker
      on this PC: no e2e test in a container. The store validator was not
      run by the development agent (it runs in the real terminal only).

- [x] **Review corrections 1** (2026-10-21): a changed certificate is
      accepted only by its fingerprint typed or by the new "Trust the new
      certificate" button, its fingerprint shown in the status (B1);
      `failed()` frozen on the failing configuration, superseded checked
      after each await (I1); one loop chain (I2); the start of an attempt
      written to `/data` (I3); M1 to M9 and M11 corrected, M8 and M10 noted
      below. A test each.

## Decisions

- **Version 0.1.0** set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-esxi:0.1.0`);
  the first release (patch) gives 0.1.1.
- **Reference**: pyVmomi (Apache-2.0, VMware / Broadcom, the official SDK),
  9.1.1.0, commit `75a18fd`, cloned read-only in `_ref/pyvmomi`; nothing
  copied, the SOAP shape and the methods ported; notice (with its NOTICE
  text) in `THIRD_PARTY_NOTICES.md`, copied into the image. No dependency
  added: about ten SOAP calls written by hand, a small XML parser (from
  gladys-linn).
- **SOAP, not REST**: the vSphere Automation REST API exists on vCenter only
  (and partly on ESXi 8); the Web Services API (`/sdk`) is on every ESXi and
  vCenter. `SOAPAction: urn:vim25/6.5`: every property read and method
  called exists since 6.5 and newer servers accept older versions
  (`vimServiceVersions.xml` is not read: one call less; to check on a real
  ESXi 9).
- **One reading = one RetrievePropertiesEx** with traversal specs from the
  root folder (folders, datacenters' VM and host folders and datastores,
  compute resources and clusters' hosts, vApps' VMs): no view to create and
  destroy, no session-bound object. `maxObjects` 100 per page, at most 6
  pages, then CancelRetrievePropertiesEx. Caps: 32 hosts, 64 datastores,
  200 VMs; templates and VMs without a readable instance UUID left out, a
  second VM with the same instance UUID (a file copy) too.
- **HTTPS only, pinned**: ESXi ships a self-signed certificate. The SHA-256
  fingerprint is typed by the user (optional field) or learned by the first
  RetrieveServiceContent, which carries no secret, and only once that answer
  is a valid vSphere service content (never the certificate of another
  service met at a wrong address or port; review 1, M4); Login and every
  request with the session cookie are `secret: true`: the transport refuses
  them unsent while no pin is known, and checks the pin right after the TLS
  handshake, before any byte is written. Another certificate (review 1, B1):
  stop, persisted with the fingerprint met (`certChanged|host:port`, not a
  secret), shown in the status in fr/en; never a new trust on first use.
  Lifted ONLY by vouching for exactly that certificate: its fingerprint typed
  in `certificate_fingerprint`, or the "Trust the new certificate" button
  (`trust_certificate`, like gladys-alfen's `trustCertificate`: pins exactly
  the one shown, then reads at once). Saving any other option keeps the
  stop. A third certificate is refused like the second.
- **Credentials refused** = fault `InvalidLogin` at Login: final, remembered
  as a salted HMAC of address, user name and password (only of a refused
  password), erased at the first reading that works; lifted only by saving
  the configuration (ESXi locks an account after failures, 5 by default).
  `NoPermission` on a reading, or `NotAuthenticated` again right after a new
  login, = the account lacks rights: spaced retry. `NotAuthenticated` on a
  reading = the session expired: one new login per reading, never a loop.
- **Faults are answers**: HTTP 500 with a SOAP Fault is classified by its
  type (`InvalidLogin`, `NotAuthenticated`, `NoPermission`,
  `ManagedObjectNotFound`, `RestrictedVersion`, others) and never pauses;
  HTTP 429, 501-599 and a 500 that is not SOAP (a proxy) pause every request
  (1 min to 6 h, Retry-After honoured, kept in `/data`). The fault text is
  never kept.
- **Never faster than the interval** (lot 11 lesson): the last attempt
  `{ at, failed, delay }` per `host:port` is kept in memory; its START is
  written to `/data` as `{ at, delay }` (the retry delay it runs with), at
  most once a minute (a later write deferred, never dropped; flushed at
  shutdown), so a restart or a crash DURING a reading waits too (review 1,
  I3). Read back from `/data`, the outcome is unknown: the retry delay
  applies (≥ the interval). A container restart, a reconnection to Gladys,
  the test button, the scan, the loop after a scan (review 1, M9) and the
  same values saved again wait for `at + interval` (or `+ retry delay`);
  only other values saved and the trust button read at once. A
  reconnection during a reading follows that reading (same client) instead
  of starting another. A reading of a replaced client (other values)
  publishes nothing and sets no status; a replaced client may only send its
  Logout (never a new Login with the old password; review 1, M5).
- **One chain of readings** (review 1, I1, I2): `failed()` freezes the
  configuration of the client that failed and checks, after each await and
  before any write, that no new start nor other failure took over; a
  configuration saved meanwhile is never marked refused nor "certificate
  changed". `connect()` and `resume()` capture the epoch and never schedule
  the loop once a failure (a VM action answered 5xx) halted it.
- **Answers**: a SOAP answer cut short (an element, a tag, a comment left
  open) is BAD_ANSWER, never read as complete (M3); text pieces count
  towards the 200,000 nodes (M2); a fault type is looked up as an own key
  only (M1); `&#xD800;`, direction overrides and a surrogate split by the
  64-character cut are dropped from names (M11).
- **External ids**: `host:<moref>` (`ha-host` on a standalone ESXi,
  `host-12` on vCenter), `datastore:<moref>` (the VMFS UUID on ESXi,
  `datastore-15` on vCenter), `vm:<instance uuid>` (stable across a rename,
  a vMotion, a reboot). Moving a standalone ESXi under a vCenter changes the
  host and datastore ids (said here only).
- **Identity**: every request is checked against the pinned certificate
  (another machine at the address after a DHCP change stops before
  anything is sent). Before an action the VM is read again at its moref:
  its instance UUID must be the one of the device; an unreadable UUID,
  connection state (review 1, M6) or power state refuses as "unknown
  state", never as "another VM".
- **Features and units** (core `DEVICE_FEATURE_UNITS_BY_CATEGORY`):
  connected, maintenance, accessible, running, VMware Tools
  `unknown`/`binary` (never a switch); CPU, memory, datastore usage
  `unknown`/`unknown` 0-100 without unit (the core has no percent for them;
  the unit in the name, like gladys-system-bridge); memory used / total,
  free space, capacity `data`/`size` gigabyte (10^9 bytes, from MiB / bytes);
  VM memory consumed `data`/`size` megabyte (10^6 bytes); uptime
  `duration`/`decimal` hours; VMs running `counter-sensor`/`integer`;
  health, power state, version `text` (the API values: `green`,
  `poweredOn`...). A host vCenter cannot reach publishes connected 0, its
  health and version only; a VM powered off publishes 0 for CPU, memory and
  uptime.
- **VM actions** (`button`/`push` on the VM device, nothing on a host):
  Start = `PowerOnVM_Task` (resumes a suspended VM), Shut down =
  `ShutdownGuest`, Restart = `RebootGuest` (VMware Tools needed). Hard power
  off, reset and suspend are not offered (data loss), nor any host action.
  None is treated as a protective command: stopping a VM can cut a
  firewall, a NAS or Gladys itself, so all three are sensitive, each behind
  its own option (`allow_vm_start`, `allow_vm_shutdown`,
  `allow_vm_restart`, off by default). Deadlines from the arrival of the
  command: the VM read again by 2 s (same instance UUID, connected, power
  state; Start on a running VM and Shut down on a stopped one are confirmed
  without sending), the request refused unsent after 3.5 s, its answer
  awaited until 4.5 s (Gladys acks within 5 s); the option, the connection,
  a pause, the cooldown and the 3.5 s deadline checked again right before
  the request is written, after the TCP and TLS handshakes (`beforeSend`);
  never retried, never preceded by a login (no session: refused, "try after
  the next reading"). Start is confirmed only by `poweredOn` read again
  before 4.5 s; otherwise, and always for the guest operations, the answer
  is "sent, without confirmation", and that VM is read once 20 s later. A
  refusal of the server (NoPermission, RestrictedVersion of a free license,
  InvalidPowerState, ToolsUnavailable...) is "refused" and never stops the
  readings; a 5xx or a silence after the request was written is "sent,
  without confirmation" and follows the usual pause. One action at a time,
  one per VM per minute: the cooldown is written to `/data` BEFORE the
  request (a stop between the request and its answer keeps it; review 1,
  M7), given back when the request certainly did not leave (beforeSend,
  too late, no session), kept after a refusal of the server; a time in the
  future counts as now. The ack never waits for a publication to Gladys.
- **No scene trigger** in v1: the device triggers of Gladys on Running,
  Connected or Used (%) cover the needs (VM stopped, host lost, datastore
  almost full).
- **Budget**: 250 states per minute, reserved synchronously before awaiting
  Gladys (two publications at the same time never exceed it together);
  transports sent by 100.
- **Logout** at a container stop and when other values replace the client
  (best effort, 3 s; ESXi forgets an idle session anyway). Not at a
  disconnection from Gladys: the session and a reading in flight are kept.
- **Caps**: answers 4 MiB, XML 200,000 elements and 32 levels, texts 64
  characters, 15 s per request, 45 s per reading.
- **No dashboard widget** in v1.

## Next

- Check against a real ESXi (7, 8, 9) and a real vCenter: the SOAPAction
  version, the fault types of a wrong password and of a read-only account,
  the session cookie, the property paths, `RestrictedVersion` on a free
  license, the time a `PowerOnVM_Task` takes to show `poweredOn`.
- A Login answered 200 without a `vmware_soap_session` cookie (review 1,
  M8): a failure with a spaced retry (one login per attempt, never a loop),
  but the session it opened on the server cannot be logged out and expires
  on its own; check on a real server whether it can happen.
- Datastores whose moref does not fit the external id pattern (review 1,
  M10: a vSAN moref such as `vsan:...` holds a colon) are left out (counted
  in the debug log); check the morefs of vSAN and vVols datastores on a real
  vCenter and map them to a stable id if needed.
- Datastore and host sensors (temperatures through the hardware status),
  network rates (PerformanceManager): more calls, to weigh.
- Snapshots count and age per VM.
- A dashboard widget (hosts and VMs at a glance).
