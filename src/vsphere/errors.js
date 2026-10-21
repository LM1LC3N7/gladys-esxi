// -----------------------------------------------------------------------------
// VsphereError: every failure of a request to the server, with a code the
// app maps to a status, a retry policy or a message. Messages never carry the
// password, the session cookie, a name of a VM nor the text of a SOAP fault
// (it may quote them): only a fault TYPE (`InvalidLogin`, `NoPermission`).
// `notSent`: the request certainly never reached the server (no connection,
// a certificate refused before anything was written, a check before sending).
// -----------------------------------------------------------------------------

export const CODES = Object.freeze({
  UNREACHABLE: 'unreachable', // no TCP connection
  TIMEOUT: 'timeout', // no answer in time
  HTTP: 'http', // an HTTP status other than 200 / a SOAP fault (see `status`)
  REDIRECT: 'redirect', // a 3xx (never followed)
  BAD_ANSWER: 'bad_answer', // not the SOAP expected, or not HTTP / TLS at all
  TOO_LARGE: 'too_large', // answer above the size cap
  CREDENTIALS: 'credentials', // InvalidLogin: the user name or the password refused
  SESSION: 'session', // NotAuthenticated: the session is no longer valid
  ACCESS: 'access', // NoPermission: the account lacks a privilege
  NOT_FOUND: 'not_found', // ManagedObjectNotFound: the VM (or host) is gone
  RESTRICTED: 'restricted', // RestrictedVersion: the license forbids it (free ESXi)
  FAULT: 'fault', // any other SOAP fault (see `fault`)
  CERTIFICATE: 'certificate', // the HTTPS certificate is not the one pinned
  NO_PIN: 'no_pin', // a secret refused on a connection not pinned yet (never sent)
  LATE: 'late', // a command that could not start in time (never sent)
  CLOSED: 'closed', // the client was replaced (new configuration)
});

export class VsphereError extends Error {
  constructor(code, message, { status, retryAfterMs, fault, notSent } = {}) {
    super(message);
    this.name = 'VsphereError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined && retryAfterMs !== null) this.retryAfterMs = retryAfterMs;
    if (fault !== undefined) this.fault = fault;
    if (notSent) this.notSent = true;
  }
}

/** The SOAP fault types the app tells apart (detail element or xsi:type, `Fault` suffix dropped). */
export const FAULT_CODES = Object.freeze({
  InvalidLogin: CODES.CREDENTIALS,
  NotAuthenticated: CODES.SESSION,
  NoPermission: CODES.ACCESS,
  ManagedObjectNotFound: CODES.NOT_FOUND,
  RestrictedVersion: CODES.RESTRICTED,
});

/** Final until the configuration is saved: user name or password refused at login. */
export const isCredentialsRefused = (err) => err?.code === CODES.CREDENTIALS;
