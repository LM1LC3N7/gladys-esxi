# gladys-esxi

A [Gladys Assistant](https://gladysassistant.com) external integration for
VMware ESXi hosts, standalone or managed by a vCenter, through the local
vSphere API (SOAP, `/sdk`).

- One Gladys device per host (picked in the Discovery tab): **connected**,
  **maintenance mode**, **CPU** and **memory** load, **memory used** and
  **total**, **uptime**, **health**, **VMs running**, **version**.
- One device per datastore: **accessible**, **used**, **free space**,
  **capacity**.
- One device per virtual machine: **running**, **power state**, **VMware
  Tools**, **CPU**, **memory consumed**, **uptime**, **health**, and
  **Start**, **Shut down (guest)**, **Restart (guest)** buttons, each off
  unless allowed in the configuration.
- Never an action on a host; never a hard power off or reset of a VM.

**Never tested with a real ESXi host nor vCenter**: the calls follow
[pyVmomi](https://github.com/vmware/pyvmomi) (Apache-2.0), the official SDK,
and are tested against a fake server only. No dependency but the Gladys SDK:
only the few SOAP calls needed are written by hand.

Unofficial integration, not affiliated with VMware or Broadcom.

## Documentation

- English: [docs/en.md](docs/en.md)
- Français : [docs/fr.md](docs/fr.md)

## Security

- A dedicated account with the Read-only role is advised; the VM buttons
  need the Power on, Power off and Reset privileges in addition.
- The password is kept by Gladys in its database, never shown again, and
  sent only to the server, only on a connection whose self-signed
  certificate matched the pinned fingerprint (typed, or learned by a first
  request that carries no secret). Another certificate stops everything
  before a byte is written.
- The password and the session cookie are never logged nor kept; `/data`
  holds a salted HMAC of refused credentials only (erased at the first
  login that works), the certificate fingerprint, the end of a pause, the
  time of the last reading attempt and of the last action on each VM.
- The VM actions are buttons (never switches), each off by default, the VM
  read again first, at most one action per VM per minute.
- See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Development

```bash
npm install
npm run format:check
npm run lint
npm test
npm run cover   # regenerate cover.png
```

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules, and
[TODO.md](TODO.md) for the status and decisions.

## License

Apache License 2.0, see [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
