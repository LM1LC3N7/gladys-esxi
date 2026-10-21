# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: a VMware ESXi host or a vCenter through its local vSphere
  API (address, optional certificate fingerprint, user name, password).
- One Gladys device per host: connected, maintenance mode, CPU and memory
  load, memory used and total, uptime, health, VMs running, version.
- One device per datastore: accessible, used, free space, capacity.
- One device per virtual machine: running, power state, VMware Tools, CPU,
  memory consumed, uptime, health; Start, Shut down (guest) and Restart
  (guest) buttons, each off by default, the VM read again first (same
  instance UUID, its power state), the option checked again right before
  sending, one action per VM per minute at most. Never an action on a host.
- The self-signed HTTPS certificate is pinned (typed, or learned by a request
  without a secret, once the answer is vSphere); the password is sent only on
  a connection whose certificate matched; another certificate stops
  everything, its fingerprint shown in the status, until the user vouches for
  exactly that one (its fingerprint typed, or the new "Trust the new
  certificate" button); saving the configuration never accepts it.
- Credentials refused stop the integration until the configuration is saved
  (remembered in `/data` as a salted HMAC, erased at the first login that
  works); HTTP 429 and 5xx pause every request, the pause kept in `/data`
  and bounded; other failures retried, never faster than the refresh, even
  across a restart of the container (the last attempt kept in `/data`).
- Test the connection button.
- A configuration saved while a failure is handled is never marked refused;
  one reading chain only, even when a VM action fails during the first
  reading; a restart during a reading waits for the interval too; a SOAP
  answer cut short is refused; a replaced configuration never logs in again;
  a VM whose connection state cannot be read is not acted on; the cooldown of
  a VM is kept before the action is sent.
- Documentation in English and French. Never tested with a real ESXi host.

[Unreleased]: https://github.com/LM1LC3N7/gladys-esxi/commits/main
