// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, button, errors). Errors
// thrown to Gladys are English (one language per message, like the core's);
// the statuses and button answers are { en, fr }. No text ever holds the
// password, the session cookie, the text of a SOAP fault nor the address.
// -----------------------------------------------------------------------------

import { CODES } from './vsphere/errors.js';

const plural = (n, one, many) => (n === 1 ? one : many);
/** French: 0 and 1 take the singular. */
const pluralFr = (n, one, many) => (n <= 1 ? one : many);
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const seconds = (ms) => Math.max(1, Math.round(ms / 1000));

/** Why the server failed, in a few words. */
export function reasonOf(err) {
  switch (err?.code) {
    case CODES.UNREACHABLE:
      return { en: 'no connection', fr: 'pas de connexion' };
    case CODES.TIMEOUT:
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case CODES.HTTP:
      return { en: `HTTP error ${err.status}`, fr: `erreur HTTP ${err.status}` };
    case CODES.BAD_ANSWER:
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case CODES.TOO_LARGE:
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case CODES.CREDENTIALS:
      return { en: 'user name or password refused', fr: 'identifiants refusés' };
    case CODES.SESSION:
      return { en: 'session expired', fr: 'session expirée' };
    case CODES.ACCESS:
      return { en: 'permission missing for this account', fr: 'droit manquant pour ce compte' };
    case CODES.NOT_FOUND:
      return { en: 'object not found', fr: 'objet introuvable' };
    case CODES.RESTRICTED:
      return {
        en: 'forbidden by the license (free ESXi)',
        fr: 'interdit par la licence (ESXi gratuit)',
      };
    case CODES.FAULT:
      return {
        en: `vSphere fault ${err.fault ?? ''}`.trim(),
        fr: `erreur vSphere ${err.fault ?? ''}`.trim(),
      };
    case CODES.CERTIFICATE:
      return { en: 'another HTTPS certificate', fr: 'autre certificat HTTPS' };
    case CODES.REDIRECT:
      return { en: 'redirection', fr: 'redirection' };
    case CODES.CLOSED:
      return { en: 'configuration changed', fr: 'configuration changée' };
    case CODES.LATE:
      return { en: 'too late', fr: 'trop tard' };
    default:
      return { en: 'error', fr: 'erreur' };
  }
}

const RETRY = (delay) => ({
  en: `Retried in ${minutes(delay)} min.`,
  fr: `Nouvel essai dans ${minutes(delay)} min.`,
});

export const join = (...parts) => ({
  en: parts
    .map((p) => p.en)
    .filter(Boolean)
    .join(' '),
  fr: parts
    .map((p) => p.fr)
    .filter(Boolean)
    .join(' '),
});

const ACTION_NAMES = {
  start: { en: 'start', fr: 'démarrage' },
  shutdown: { en: 'shutdown', fr: 'arrêt' },
  restart: { en: 'restart', fr: 'redémarrage' },
};
const actionName = (action) => ACTION_NAMES[action]?.en ?? 'action';

export const T = {
  status: {
    ok: ({ server, hosts, vms, running }) => ({
      en: `${server ?? 'The server'} answers: ${hosts} ${plural(hosts, 'host', 'hosts')}, ${running} of ${vms} ${plural(vms, 'VM', 'VMs')} running.`,
      fr: `${server ?? 'Le serveur'} répond : ${hosts} ${pluralFr(hosts, 'hôte', 'hôtes')}, ${running} ${pluralFr(running, 'VM', 'VM')} en marche sur ${vms}.`,
    }),
    hostMissing: {
      en: 'Type the address of the ESXi host or of the vCenter, e.g. 192.168.1.10.',
      fr: 'Saisissez l’adresse de l’hôte ESXi ou du vCenter, ex. 192.168.1.10.',
    },
    hostInvalid: {
      en: 'The address is not valid: type an IP address or a host name (e.g. 192.168.1.10), in HTTPS, without a path or query.',
      fr: 'L’adresse n’est pas valide : saisissez une adresse IP ou un nom d’hôte (ex. 192.168.1.10), en HTTPS, sans chemin ni paramètres.',
    },
    portInvalid: {
      en: 'The port must be a number between 1 and 65535 (empty: 443).',
      fr: 'Le port doit être un nombre entre 1 et 65535 (vide : 443).',
    },
    pinInvalid: {
      en: 'The certificate fingerprint must be a SHA-256 fingerprint (64 hexadecimal digits, colons allowed), or empty.',
      fr: 'L’empreinte du certificat doit être une empreinte SHA-256 (64 caractères hexadécimaux, deux-points permis), ou vide.',
    },
    usernameMissing: {
      en: 'Type the user name of the account Gladys uses (a read-only account is advised).',
      fr: 'Saisissez le nom d’utilisateur du compte utilisé par Gladys (un compte en lecture seule est conseillé).',
    },
    usernameInvalid: {
      en: 'The user name holds a space or an invisible character: type it again.',
      fr: 'Le nom d’utilisateur contient une espace ou un caractère invisible : saisissez-le de nouveau.',
    },
    missingPassword: {
      en: 'Type the password of the account.',
      fr: 'Saisissez le mot de passe du compte.',
    },
    passwordInvalid: {
      en: 'The password holds a line break or an invisible character (copied with it?), or is too long: paste it again.',
      fr: 'Le mot de passe contient un retour à la ligne ou un caractère invisible (copié avec ?), ou est trop long : collez-le de nouveau.',
    },
    credentialsRefused: {
      en: 'The server refused the user name or the password. Gladys does not try again by itself (ESXi locks an account after a few failures): check them and save the configuration.',
      fr: 'Le serveur a refusé le nom d’utilisateur ou le mot de passe. Gladys ne réessaie pas seul (ESXi bloque un compte après quelques échecs) : vérifiez-les et enregistrez la configuration.',
    },
    certificateChanged: (fingerprint) => ({
      en: `The HTTPS certificate of the server is not the one Gladys knows (a reinstall, a renewed certificate, or another machine at this address). The password was not sent, and nothing is sent until you vouch for it, whatever you save. Its SHA-256 fingerprint: ${fingerprint}. Compare it with the one of your server (browser, ESXi console); if it is the same, press "Trust the new certificate" or type it in the fingerprint field.`,
      fr: `Le certificat HTTPS du serveur n’est pas celui que Gladys connaît (réinstallation, certificat renouvelé, ou autre machine à cette adresse). Le mot de passe n’a pas été envoyé, et rien ne l’est tant que vous ne le validez pas, quoi que vous enregistriez. Son empreinte SHA-256 : ${fingerprint}. Comparez-la avec celle de votre serveur (navigateur, console ESXi) ; si c’est la même, appuyez sur « Faire confiance au nouveau certificat » ou saisissez-la dans le champ de l’empreinte.`,
    }),
    certificateNotTyped: (fingerprint) => ({
      en: `The HTTPS certificate of the server is not the one whose fingerprint you typed. The password was not sent. The server shows: ${fingerprint}. If it is the right one, type it in the fingerprint field (or empty the field and press "Trust the new certificate").`,
      fr: `Le certificat HTTPS du serveur n’est pas celui dont vous avez saisi l’empreinte. Le mot de passe n’a pas été envoyé. Le serveur présente : ${fingerprint}. Si c’est le bon, saisissez-la dans le champ de l’empreinte (ou videz le champ et appuyez sur « Faire confiance au nouveau certificat »).`,
    }),
    access: (delay) =>
      join(
        {
          en: 'The server accepts the login but refuses the readings: give this account the Read-only role on the host (or on the vCenter root).',
          fr: 'Le serveur accepte la connexion mais refuse les lectures : donnez à ce compte le rôle Lecture seule sur l’hôte (ou à la racine du vCenter).',
        },
        RETRY(delay),
      ),
    redirect: (delay) =>
      join(
        {
          en: 'The server answers with a redirection: check the address and the port (the API of ESXi and vCenter is on 443).',
          fr: 'Le serveur répond par une redirection : vérifiez l’adresse et le port (l’API d’ESXi et du vCenter est sur le 443).',
        },
        RETRY(delay),
      ),
    notVsphere: (delay) =>
      join(
        {
          en: 'This address does not answer like the API of an ESXi host or a vCenter (/sdk): check the address and the port.',
          fr: 'Cette adresse ne répond pas comme l’API d’un hôte ESXi ou d’un vCenter (/sdk) : vérifiez l’adresse et le port.',
        },
        RETRY(delay),
      ),
    busy: (delay) =>
      join(
        {
          en: 'The server asks Gladys to slow down (HTTP 429): every request is paused.',
          fr: 'Le serveur demande à Gladys de ralentir (HTTP 429) : toutes les requêtes sont suspendues.',
        },
        RETRY(delay),
      ),
    serverError: (status, delay) =>
      join(
        {
          en: `The server answers with a server error (HTTP ${status}): every request is paused.`,
          fr: `Le serveur répond par une erreur serveur (HTTP ${status}) : toutes les requêtes sont suspendues.`,
        },
        RETRY(delay),
      ),
    paused: (delay) =>
      join(
        {
          en: 'The server asked Gladys to wait (HTTP 429 or a server error): the pause goes on.',
          fr: 'Le serveur a demandé à Gladys d’attendre (HTTP 429 ou erreur serveur) : la pause continue.',
        },
        RETRY(delay),
      ),
    waiting: (delay) => ({
      en: `The server was read less than one refresh ago: next reading in ${seconds(delay)} s.`,
      fr: `Le serveur a été lu il y a moins d’un rafraîchissement : prochaine lecture dans ${seconds(delay)} s.`,
    }),
    failedBefore: (delay) =>
      join(
        {
          en: 'The last reading failed.',
          fr: 'La dernière lecture a échoué.',
        },
        RETRY(delay),
      ),
    reading: {
      en: 'Reading the server…',
      fr: 'Lecture du serveur…',
    },
    unreachable: (err, delay) =>
      join(
        { en: 'The server does not answer:', fr: 'Le serveur ne répond pas :' },
        reasonOf(err),
        { en: '—', fr: '—' },
        RETRY(delay),
      ),
    failing: (err, delay) =>
      join(
        { en: 'The reading failed:', fr: 'La lecture a échoué :' },
        reasonOf(err),
        { en: '—', fr: '—' },
        RETRY(delay),
      ),
  },
  trust: {
    nothing: {
      en: 'No changed certificate to trust: nothing done.',
      fr: 'Aucun certificat changé à valider : rien n’a été fait.',
    },
    typed: (fingerprint) => ({
      en: `The fingerprint field holds another fingerprint: type ${fingerprint} there, or empty it, then save and press the button again.`,
      fr: `Le champ de l’empreinte en contient une autre : saisissez-y ${fingerprint}, ou videz-le, puis enregistrez et appuyez de nouveau.`,
    }),
    done: (fingerprint) => ({
      en: `Certificate ${fingerprint} trusted.`,
      fr: `Certificat ${fingerprint} validé.`,
    }),
  },
  test: {
    ok: (status) =>
      join(status, {
        en: 'Add the hosts, datastores and VMs from the Discovery tab.',
        fr: 'Ajoutez les hôtes, datastores et VM depuis l’onglet Découverte.',
      }),
  },
  errors: {
    readOnly: 'This feature only reads the server: nothing can be changed from it',
    unknownDevice: 'This device is not part of this server',
    badValue: 'Invalid value for a button',
    disabled: (action) =>
      `The VM ${actionName(action)} is not allowed: turn it on in the configuration of the integration`,
    notConnected: 'The server is not connected: see the configuration of the integration',
    paused: (delay) =>
      `The server asked Gladys to wait: nothing sent, try again in ${minutes(delay)} min`,
    stillRunning: 'A VM action is already being sent',
    cooldown: (ago) =>
      `An action was sent to this VM ${seconds(ago)} s ago: nothing sent (1 min between two actions on a VM)`,
    unknownVm: 'This VM is not in the last reading of the server: nothing sent (see Discovery)',
    tooSlow: 'The server did not answer in time: nothing was sent',
    noSession:
      'No valid session with the server just before sending: nothing was sent, try again after the next reading',
    unknownState: (reason) =>
      `The VM could not be read just before the action (${reason}): nothing was sent`,
    otherVm: 'The VM at this place is not the one read before: nothing was sent (see Discovery)',
    vmGone: 'The VM is no longer on the server (moved, removed): nothing was sent (see Discovery)',
    vmNotConnected:
      'The server does not reach this VM (disconnected, orphaned, inaccessible): nothing was sent',
    toolsNotRunning: (action) =>
      `VMware Tools does not run in this VM: a clean ${actionName(action)} is impossible, nothing was sent`,
    notRunning: 'The VM is not running: nothing was sent',
    suspended: 'The VM is suspended: start it first, nothing was sent',
    notSent: (action, reason) => `The VM ${actionName(action)} was not sent (${reason})`,
    refused: (action, reason) => `The server refused the VM ${actionName(action)} (${reason})`,
    sentUnconfirmed: (action, reason) =>
      `The VM ${actionName(action)} was sent, without confirmation from the server (${reason}): its state is read again in a moment`,
    startUnconfirmed:
      'The VM start was sent, without confirmation yet (the VM is not running yet): its state is read again in a moment',
    guestAsked: (action) =>
      `The VM ${actionName(action)} was sent to the guest system, which does it on its own, without confirmation yet: the state of the VM is read again in a moment`,
    testTooLong:
      'The server has not answered yet: see the connection status in a moment (nothing else to do)',
  },
};
