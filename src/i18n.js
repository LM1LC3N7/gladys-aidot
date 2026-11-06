// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, device and feature names,
// refusals of a command), in English and French. Never a secret in them (the
// password, a token, the user id, a key, the e-mail).
// -----------------------------------------------------------------------------

import { FEATURES as F } from './constants.js';

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

export const both = (en, fr) => ({ en, fr });

/** "45 s" / "25 min" / "3 h", for the waits. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return both(`${seconds} s`, `${seconds} s`);
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return both(`${minutes} min`, `${minutes} min`);
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const FEATURE_NAMES = {
  [F.POWER]: both('Power', 'Allumage'),
  [F.BRIGHTNESS]: both('Brightness', 'Intensité'),
  [F.COLOR]: both('Color', 'Couleur'),
  [F.TEMPERATURE]: both('Color temperature', 'Température de couleur'),
};

/** The id shown to the user: its first 8 characters. */
export const shortId = (id) => String(id).slice(0, 8);

/** The name of a light: its name in the AiDot app, else "AiDot light 1a2b3c4d". */
export function deviceName(light, language) {
  if (light.name) return light.name;
  return word(
    both(`AiDot light ${shortId(light.id)}`, `Lumière AiDot ${shortId(light.id)}`),
    language,
  );
}

/** The reason of a failure of a light (a LinkError), in each language. */
export function reasonOf(err) {
  switch (err?.code) {
    case 'network':
      return both(
        `no connection (${String(err.detail ?? 'error').slice(0, 40)})`,
        `pas de connexion (${String(err.detail ?? 'error').slice(0, 40)})`,
      );
    case 'unknown':
      return both(
        'the light is not known yet (the AiDot cloud not read)',
        'la lumière n’est pas encore connue (cloud AiDot pas lu)',
      );
    case 'identity':
      return both(
        'another light or another key answers at this address',
        'une autre lumière ou une autre clé répond à cette adresse',
      );
    case 'login':
      return both('the light refused the login', 'la lumière a refusé la connexion');
    case 'timeout':
      return both('no answer in time', 'pas de réponse à temps');
    case 'late':
      return both('no time left to send', 'plus le temps d’envoyer');
    case 'cut':
      return both('interrupted', 'interrompue');
    case 'closed':
      return both('connection closed', 'connexion fermée');
    case 'refused':
      return both(
        `refused by the light (code ${err.deviceCode ?? '?'})`,
        `refusée par la lumière (code ${err.deviceCode ?? '?'})`,
      );
    case 'stopped':
      return both('the integration stops', 'l’intégration s’arrête');
    default:
      return both('internal error', 'erreur interne');
  }
}

/** The reason of a failure of the cloud (a CloudError), in each language. */
export function cloudReasonOf(err) {
  const status = err?.status ? ` HTTP ${err.status}` : '';
  switch (err?.kind) {
    case 'network':
      return both(
        `not reached (${String(err.detail ?? 'error').slice(0, 40)})`,
        `injoignable (${String(err.detail ?? 'error').slice(0, 40)})`,
      );
    case 'timeout':
      return both('no answer in time', 'pas de réponse à temps');
    case 'size':
      return both('answer too large', 'réponse trop grande');
    case 'bad_response':
      return both('unexpected answer', 'réponse inattendue');
    case 'session':
    case 'denied':
      return both(`session not accepted${status}`, `session non acceptée${status}`);
    case 'rate':
      return both('too many requests (429)', 'trop de requêtes (429)');
    case 'unavailable':
      return both(`unavailable${status}`, `indisponible${status}`);
    case 'http':
      return both(`error${status}`, `erreur${status}`);
    default:
      return both('internal error', 'erreur interne');
  }
}

const CONFIG_ERRORS = {
  no_credentials: both(
    'Enter the e-mail and the password of your AiDot account.',
    'Saisissez l’e-mail et le mot de passe de votre compte AiDot.',
  ),
  no_email: both(
    'A password without an e-mail: enter the e-mail of your AiDot account.',
    'Un mot de passe sans e-mail : saisissez l’e-mail de votre compte AiDot.',
  ),
  no_password: both(
    'Enter the password of your AiDot account.',
    'Saisissez le mot de passe de votre compte AiDot.',
  ),
  bad_email: both('The e-mail is not understood.', 'L’e-mail n’est pas compris.'),
  bad_password: both(
    'The password holds a line break: it cannot be sent.',
    'Le mot de passe contient un retour à la ligne : il ne peut pas être envoyé.',
  ),
};

const GUARD_WHY = {
  refused: both(
    'not before: the credentials are refused; correct them or click "Test the connection"',
    'pas avant : les identifiants sont refusés ; corrigez-les ou cliquez sur « Tester la connexion »',
  ),
  config: both(
    'not before: no usable credentials in the configuration',
    'pas avant : aucun identifiant utilisable dans la configuration',
  ),
  failed: both(
    'the cloud does not answer: tried every minute',
    'le cloud ne répond pas : essayé toutes les minutes',
  ),
  error: both(
    'the cloud answers an error: tried again after 1, 2, 5, then every 10 min',
    'le cloud répond une erreur : réessayé après 1, 2, 5, puis toutes les 10 min',
  ),
  paused: both(
    'the cloud asked to wait: tried every 10 min at most',
    'le cloud a demandé d’attendre : essayé toutes les 10 min au plus',
  ),
  pending: both('read in progress or due', 'lecture en cours ou prévue'),
  unlisted: both(
    'the light is not in the list of the account',
    'la lumière n’est pas dans la liste du compte',
  ),
};

export const T = {
  configError: (code) => CONFIG_ERRORS[code] ?? CONFIG_ERRORS.no_credentials,
  countryError: both(
    'The country is not in the list: the default one is used.',
    'Le pays n’est pas dans la liste : celui par défaut est utilisé.',
  ),
  configNotRead: (wait) =>
    both(
      `The configuration could not be read from Gladys; new try in ${wait.en}.`,
      `La configuration n’a pas pu être lue depuis Gladys ; nouvel essai dans ${wait.fr}.`,
    ),
  signingIn: both('AiDot cloud: signing in…', 'Cloud AiDot : connexion en cours…'),
  waitingGap: (wait) =>
    both(
      `AiDot cloud: read in ${wait.en} (a minute between two reads).`,
      `Cloud AiDot : lecture dans ${wait.fr} (une minute entre deux lectures).`,
    ),
  refused: both(
    'AiDot refused the e-mail or the password: correct them and save, or click "Test the connection". Nothing is sent again by itself.',
    'AiDot a refusé l’e-mail ou le mot de passe : corrigez-les et enregistrez, ou cliquez sur « Tester la connexion ». Rien n’est renvoyé de lui-même.',
  ),
  paused: (wait) =>
    both(
      `AiDot cloud: asked to wait, new read in ${wait.en}.`,
      `Cloud AiDot : demande d’attendre, nouvelle lecture dans ${wait.fr}.`,
    ),
  cloudFailed: (reason, wait) =>
    both(
      `AiDot cloud: ${reason.en}, new try in ${wait.en}.`,
      `Cloud AiDot : ${reason.fr}, nouvel essai dans ${wait.fr}.`,
    ),
  lights: (n, created, reachable) =>
    both(
      `${n} light(s) in the account; ${reachable} of the ${created} added reachable on the network.`,
      `${n} lumière(s) dans le compte ; ${reachable} des ${created} ajoutée(s) joignable(s) sur le réseau.`,
    ),
  noLight: both(
    'No AiDot light with a local key in this account.',
    'Aucune lumière AiDot avec une clé locale dans ce compte.',
  ),
  tooMany: (max) =>
    both(
      `More than ${max} lights: the others are ignored.`,
      `Plus de ${max} lumières : les autres sont ignorées.`,
    ),
  toAdd: (n) =>
    both(`${n} light(s) to add in Discover.`, `${n} lumière(s) à ajouter dans Découverte.`),
  unreachable: (name, reason, wait) =>
    both(
      `${name}: unreachable (${reason.en}), next try in ${wait.en}.`,
      `${name} : injoignable (${reason.fr}), nouvel essai dans ${wait.fr}.`,
    ),
  noAddress: (name) =>
    both(
      `${name}: no address known (the cloud gives none, the discovery did not find it).`,
      `${name} : aucune adresse connue (le cloud n’en donne pas, la découverte ne l’a pas trouvée).`,
    ),
  guardUnknown: (name, why) =>
    both(
      `Off of ${name}: kept, sent as soon as the AiDot cloud gives the key of the light (${GUARD_WHY[why].en}).`,
      `Arrêt de ${name} : gardé, envoyé dès que le cloud AiDot donne la clé de la lumière (${GUARD_WHY[why].fr}).`,
    ),
  guardPending: (name) =>
    both(
      `Off of ${name}: not sent or not answered yet, kept and sent again every 10 s.`,
      `Arrêt de ${name} : pas encore envoyé ou sans réponse, gardé et renvoyé toutes les 10 s.`,
    ),
  guardWaiting: (name, tries) =>
    both(
      `Off of ${name}: answered by the light (${tries} time(s)), not seen applied yet; held.`,
      `Arrêt de ${name} : répondu par la lumière (${tries} fois), pas encore vu appliqué ; gardé.`,
    ),
  guardExhausted: (name) =>
    both(
      `Off of ${name}: answered 4 times by the light, still on; no longer sent again, click Off to retry.`,
      `Arrêt de ${name} : répondu 4 fois par la lumière, toujours allumée ; plus renvoyé, recliquez sur Arrêt pour réessayer.`,
    ),
  storeProblem: both(
    '/data could not be written: the Offs held are kept in memory only.',
    '/data n’a pas pu être écrit : les arrêts gardés le sont en mémoire seulement.',
  ),
  storeUnreadable: both(
    '/data could not be read: nothing is written over it until it reads again.',
    '/data n’a pas pu être lu : rien n’est écrit par-dessus tant qu’il ne se relit pas.',
  ),
  test: {
    config: (error) => CONFIG_ERRORS[error] ?? CONFIG_ERRORS.no_credentials,
    cooldown: (wait) =>
      both(
        `Tried less than 10 s ago, new try possible in ${wait.en}.`,
        `Essayé il y a moins de 10 s, nouvel essai possible dans ${wait.fr}.`,
      ),
    paused: (wait) =>
      both(
        `The AiDot cloud asked to wait: new try possible in ${wait.en}.`,
        `Le cloud AiDot a demandé d’attendre : nouvel essai possible dans ${wait.fr}.`,
      ),
    refused: both(
      'AiDot refused the e-mail or the password.',
      'AiDot a refusé l’e-mail ou le mot de passe.',
    ),
    failed: (reason) =>
      both(`AiDot cloud: failed (${reason.en}).`, `Cloud AiDot : échec (${reason.fr}).`),
    ok: (n, created, reachable) =>
      both(
        `Signed in: ${n} light(s) in the account; ${reachable} of the ${created} added reachable on the network.`,
        `Connecté : ${n} lumière(s) dans le compte ; ${reachable} des ${created} ajoutée(s) joignable(s) sur le réseau.`,
      ),
  },
};

export const ERRORS = {
  notCommandable: both(
    'This feature cannot be driven.',
    'Cette fonctionnalité ne peut pas être pilotée.',
  ),
  badValue: both('Invalid value: nothing was sent.', 'Valeur invalide : rien n’a été envoyé.'),
  outOfRange: (min, max) =>
    both(
      `Out of the range of this light (${min}-${max} K): nothing was sent.`,
      `Hors de la plage de cette lumière (${min}-${max} K) : rien n’a été envoyé.`,
    ),
  notSupported: both(
    'This light does not have this feature: nothing was sent.',
    'Cette lumière n’a pas cette fonctionnalité : rien n’a été envoyé.',
  ),
  configNotLoaded: both(
    'The configuration has not been read from Gladys yet: nothing was sent.',
    'La configuration n’a pas encore été lue depuis Gladys : rien n’a été envoyé.',
  ),
  lightUnknown: both(
    'This light is not known yet (the AiDot cloud is not read): nothing was sent.',
    'Cette lumière n’est pas encore connue (le cloud AiDot n’est pas lu) : rien n’a été envoyé.',
  ),
  noAddress: both(
    'No address known for this light: nothing was sent.',
    'Aucune adresse connue pour cette lumière : rien n’a été envoyé.',
  ),
  stopPending: both(
    'An Off is being sent to this light: nothing was sent.',
    'Un arrêt est en cours d’envoi à cette lumière : rien n’a été envoyé.',
  ),
  cancelledByStop: both(
    'Cancelled by a newer command (an Off): nothing was sent.',
    'Annulée par une commande plus récente (un arrêt) : rien n’a été envoyé.',
  ),
  queueFull: both(
    'Too many commands waiting: nothing was sent.',
    'Trop de commandes en attente : rien n’a été envoyé.',
  ),
  queued: both(
    'Not sent yet: waiting for the connection to the light; it leaves within 30 s or is dropped.',
    'Pas encore envoyée : en attente de la connexion à la lumière ; elle part sous 30 s ou est abandonnée.',
  ),
  tooOld: both(
    'Not sent within 30 s: dropped, nothing was sent.',
    'Pas envoyée en 30 s : abandonnée, rien n’a été envoyé.',
  ),
  restarting: both(
    'The integration is restarting: nothing was sent.',
    'L’intégration redémarre : rien n’a été envoyé.',
  ),
  notSent: (reason) =>
    both(`Nothing was sent (${reason.en}).`, `Rien n’a été envoyé (${reason.fr}).`),
  rejected: (reason) =>
    both(
      `The light refused the command (${reason.en}).`,
      `La lumière a refusé la commande (${reason.fr}).`,
    ),
  unconfirmed: both(
    'Sent, without confirmation: the light is read again in 5 s.',
    'Envoyée, sans confirmation : la lumière est relue dans 5 s.',
  ),
  notApplied: both(
    'Sent, but the light shows another state: it is read again in 5 s.',
    'Envoyée, mais la lumière montre un autre état : elle est relue dans 5 s.',
  ),
  protectiveKept: (reason) =>
    both(
      `Off not sent yet (${reason.en}): kept, and sent as soon as the light answers (every 10 s).`,
      `Arrêt pas encore envoyé (${reason.fr}) : gardé, et envoyé dès que la lumière répond (toutes les 10 s).`,
    ),
  offRefused: (reason) =>
    both(
      `Off sent, refused by the light (${reason.en}): held, sent again in 10 s.`,
      `Arrêt envoyé, refusé par la lumière (${reason.fr}) : gardé, renvoyé dans 10 s.`,
    ),
  offUnconfirmed: both(
    'Off sent, without confirmation yet: held, sent again in 10 s if it got no answer or a read still shows the light on.',
    'Arrêt envoyé, sans confirmation pour l’instant : gardé, renvoyé dans 10 s s’il n’a pas eu de réponse ou si une lecture montre encore la lumière allumée.',
  ),
};
