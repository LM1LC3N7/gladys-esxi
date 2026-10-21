# Third-party notices

Nothing but the Gladys SDK is installed at runtime. One library's knowledge
of the vSphere API is ported to JavaScript; its notice follows.

## pyVmomi

- Project: <https://github.com/vmware/pyvmomi>, published on PyPI as
  `pyvmomi` (the official Python SDK of the vSphere API, by VMware, now
  Broadcom).
- Version read: 9.1.1.0 (PyPI, 2026-09-03), repository commit `75a18fd`
  (2026-06-22).
- License: Apache License, Version 2.0. The full text of the Apache License
  2.0 is the `LICENSE` file of this repository (identical text), copied into
  the Docker image next to this file.
- Its NOTICE file reads, in full:

  > pyVmomi
  > =======
  >
  > Copyright (c) 2005-2024 Broadcom. All Rights Reserved.
  > The term "Broadcom" refers to Broadcom Inc. and/or its subsidiaries.
  >
  > This product is licensed to you under the Apache License, Version 2.0 (the
  > "License"). You may not use this product except in compliance with the License.

What is ported (rewritten in JavaScript, not copied): the shape of a vim25
SOAP request (`pyVmomi/SoapAdapter.py`: the envelope, the body element named
after the method in the `urn:vim25` namespace with its `_this` reference
first, the `SOAPAction` header, the `vmware_soap_session` cookie, a fault as
HTTP 500 with a `soapenv:Fault`), the methods and parameters this
integration calls as its type information describes them
(`RetrieveServiceContent`, `Login`, `Logout`, `RetrievePropertiesEx`,
`ContinueRetrievePropertiesEx`, `CancelRetrievePropertiesEx` with a
`PropertyFilterSpec` and its traversal specs, `PowerOnVM_Task`,
`ShutdownGuest`, `RebootGuest`) and the property paths read, in
`src/vsphere/soap.js`, `src/vsphere/client.js` and `src/vsphere/parse.js`.
Changed from the original: the HTTPS certificate is pinned (typed, or learned
by a request without a secret) and the password is sent only on a connection
whose certificate matched; a size cap and a deadline on every answer; no
redirect followed; the text of a SOAP fault is never kept, only its type; no
other method of the API is reachable. Nothing of pyVmomi runs in the image.

VMware, ESXi, vCenter and vSphere are trademarks of Broadcom; this
integration is unofficial and not affiliated with VMware or Broadcom.

## LM1LC3N7/gladys-teltonika and LM1LC3N7/gladys-linn

The structure of the app (start queue, epochs of the loop, refusal kept as
a salted HMAC in `/data`, certificate pinned before any secret, bounded
pauses, state budget, transport badges, the deadlines of a command) follows
the Teltonika integration, and the XML parser follows the one of the Linn
integration, both of the same author, under the Apache License 2.0 of this
repository.
