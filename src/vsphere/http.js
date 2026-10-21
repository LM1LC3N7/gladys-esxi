// -----------------------------------------------------------------------------
// The only network access of the integration: one HTTPS request to the server
// (ESXi or vCenter), on node:https. A deadline for the whole exchange, a size
// cap on the body, no redirect followed (the password and the session cookie
// never go anywhere else).
//
// ESXi ships a self-signed certificate, so no authority can vouch for it. The
// certificate is pinned instead: its SHA-256 fingerprint is checked right
// after the TLS handshake, BEFORE a single byte of the request is written.
// `pin: null` accepts any certificate and reports its fingerprint: only for a
// request without a secret (the first RetrieveServiceContent, which learns
// the pin). `secret: true` (the login, any request with the session cookie)
// is refused unsent while no pin is known: the password only ever travels on
// a connection whose certificate was checked. `beforeSend()` runs at that same
// moment, the very last check of a command: what it throws is rethrown marked
// `notSent`.
//
// Resolves { status, headers, body, fingerprint } for any status; rejects a
// VsphereError for the transport failures, whose message never holds the
// address (Node's messages do).
// -----------------------------------------------------------------------------

import https from 'node:https';
import { isIP } from 'node:net';
import { CODES, VsphereError } from './errors.js';

function transportError(err, sent) {
  const code = String(err?.code ?? '');
  // Something answered, but not in HTTP or TLS (a wrong port, the wrong protocol).
  if (code.startsWith('HPE_') || code === 'EPROTO' || code.startsWith('ERR_SSL')) {
    return new VsphereError(CODES.BAD_ANSWER, `Not the expected protocol (${code})`, {
      notSent: !sent,
    });
  }
  return new VsphereError(
    CODES.UNREACHABLE,
    /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'Connection failed',
    { notSent: !sent },
  );
}

/**
 * @param {{ host: string, port: number, path: string }} target
 * @param {object} options
 * @param {Record<string, string>} [options.headers]
 * @param {string} options.body the SOAP envelope
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} options.maxBytes body size cap
 * @param {string|null} [options.pin] the expected SHA-256 fingerprint
 * @param {boolean} [options.secret] the request carries a secret: a pin is required
 * @param {() => void} [options.beforeSend]
 */
export function httpRequest(
  { host, port, path },
  { headers = {}, body, timeout, maxBytes, pin = null, secret = false, beforeSend } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let req = null;
    let fingerprint = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    if (secret && !pin) {
      reject(new VsphereError(CODES.NO_PIN, 'No pinned certificate yet', { notSent: true }));
      return;
    }
    const timer = setTimeout(
      () =>
        finish(
          new VsphereError(CODES.TIMEOUT, `No answer within ${Math.round(timeout / 1000)} s`, {
            notSent: !sent,
          }),
        ),
      timeout,
    );

    /** The connection is up (TLS checked): the last checks, then the request. */
    const ready = (socket) => {
      if (settled) return;
      fingerprint = socket.getPeerCertificate?.()?.fingerprint256 ?? null;
      if (!fingerprint) {
        finish(new VsphereError(CODES.CERTIFICATE, 'No certificate', { notSent: true }));
        return;
      }
      if (pin && fingerprint !== pin) {
        finish(
          Object.assign(
            new VsphereError(CODES.CERTIFICATE, 'Another certificate', { notSent: true }),
            { fingerprint },
          ),
        );
        return;
      }
      if (beforeSend) {
        try {
          beforeSend();
        } catch (err) {
          finish(Object.assign(err, { notSent: true, beforeSend: true }));
          return;
        }
      }
      sent = true;
      req.end(body);
    };

    try {
      const bare = host.replace(/^\[(.*)\]$/, '$1');
      const options = {
        method: 'POST',
        host: bare,
        port,
        path,
        agent: false,
        headers: {
          'content-type': 'text/xml; charset=utf-8',
          'content-length': String(Buffer.byteLength(body)),
          ...headers,
        },
        // Self-signed: checked by the pin above, not by an authority.
        rejectUnauthorized: false,
      };
      if (!isIP(bare)) options.servername = bare;
      req = https.request(options, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxBytes) {
            finish(new VsphereError(CODES.TOO_LARGE, `Answer above ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks, size),
            fingerprint,
          }),
        );
        res.on('error', (err) => finish(transportError(err, sent)));
      });
      req.on('socket', (socket) => socket.once('secureConnect', () => ready(socket)));
      req.on('error', (err) => finish(transportError(err, sent)));
    } catch (err) {
      // https.request throws synchronously on a value it refuses: a failure,
      // never a crash.
      finish(transportError(err, false));
    }
  });
}
