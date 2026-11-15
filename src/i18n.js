// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature names, the status of the
// integration, the answers of the buttons and the command refusals. None of
// them ever carries a key, a token, the account or a verification code.
// -----------------------------------------------------------------------------

export const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'fr' ? value.fr : value.en);

/** "45 s", "5 min", "2 h". */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/** Texts joined with ". ", in both languages. */
export function join(...parts) {
  const list = parts.filter(Boolean);
  return both(list.map((p) => p.en).join('. '), list.map((p) => p.fr).join('. '));
}

const FEATURES = {
  onoff: both('On/off', 'Marche/arrêt'),
  brightness: both('Brightness', 'Luminosité'),
  position: both('Position', 'Position'),
  temperature: both('Temperature', 'Température'),
  humidity: both('Humidity', 'Humidité'),
  pressure: both('Pressure', 'Pression'),
  illuminance: both('Illuminance', 'Luminosité ambiante'),
  co2: both('CO2', 'CO2'),
  pm25: both('PM2.5', 'PM2,5'),
  voc: both('VOC', 'COV'),
  battery: both('Battery', 'Batterie'),
  power: both('Power', 'Puissance'),
  voltage: both('Voltage', 'Tension'),
  current: both('Current', 'Intensité'),
  contact: both('Door/window', 'Porte/fenêtre'),
  leak: both('Water leak', 'Fuite d’eau'),
  occupancy: both('Presence', 'Présence'),
  smoke: both('Smoke', 'Fumée'),
  co: both('Carbon monoxide', 'Monoxyde de carbone'),
};

/** The name of a feature (with its endpoint when it is not the first one). */
export function featureLabel(key, endpoint, language) {
  const base = word(FEATURES[key] ?? both(key, key), language);
  return endpoint > 1 ? `${base} ${endpoint}` : base;
}

const CONFIG_KEYS = {
  region: both('server', 'serveur'),
  app_id: both('App ID', 'App ID'),
  key_id: both('Key ID', 'Key ID'),
  app_key: both('App Key', 'App Key'),
  account: both('Aqara account', 'compte Aqara'),
  access_token: both('access token', 'jeton d’accès'),
  refresh_token: both('refresh token', 'jeton de renouvellement'),
};

const KINDS = {
  network: both('network error', 'erreur réseau'),
  timeout: both('no answer in time', 'pas de réponse à temps'),
  bad: both(
    'an answer that is not the one of the Aqara Open API',
    'une réponse qui n’est pas celle de l’API ouverte Aqara',
  ),
  'too-large': both('an answer too large', 'une réponse trop grande'),
  permission: both(
    'a permission refused by Aqara (an IP restriction of the project?)',
    'une autorisation refusée par Aqara (une restriction d’adresse IP du projet ?)',
  ),
  clock: both(
    'Aqara refused the date of the request: check the clock of the Gladys host',
    'Aqara a refusé la date de la requête : vérifiez l’horloge de l’hôte de Gladys',
  ),
  refused: both('a refusal of Aqara', 'un refus d’Aqara'),
  device: both('a device error', 'une erreur d’appareil'),
  rate: both('too many requests', 'trop de requêtes'),
  server: both('Aqara is busy or failing', 'Aqara est occupé ou en panne'),
  budget: both('the daily call budget is spent', 'le budget d’appels du jour est épuisé'),
  grant: both('the authorization is over', 'l’autorisation a pris fin'),
  config: both('the configuration is incomplete', 'la configuration est incomplète'),
};

const kindText = (kind, code) => {
  const text = KINDS[kind] ?? both(String(kind), String(kind));
  return code === undefined ? text : both(`${text.en} (code ${code})`, `${text.fr} (code ${code})`);
};

export const T = {
  connected: (devices, features) =>
    both(
      `Connected to the Aqara Open API: ${devices} devices, ${features} values`,
      `Connecté à l’API ouverte Aqara : ${devices} appareils, ${features} valeurs`,
    ),
  configMissing: (keys) =>
    both(
      `Configuration incomplete or invalid: ${keys.map((k) => CONFIG_KEYS[k]?.en ?? k).join(', ')}`,
      `Configuration incomplète ou invalide : ${keys.map((k) => CONFIG_KEYS[k]?.fr ?? k).join(', ')}`,
    ),
  accountInvalid: both(
    'The Aqara account is not an e-mail address nor a phone number',
    'Le compte Aqara n’est ni une adresse e-mail ni un numéro de téléphone',
  ),
  notAuthorized: both(
    'Not authorized yet: click "Send the verification code", then enter the code received and click "Authorize"',
    'Pas encore autorisé : cliquez sur « Envoyer le code de vérification », puis saisissez le code reçu et cliquez sur « Autoriser »',
  ),
  configNotRead: (wait) =>
    both(
      `The configuration could not be read from Gladys; next try in ${age(wait)}`,
      `La configuration n’a pas pu être lue dans Gladys ; nouvel essai dans ${age(wait)}`,
    ),
  keysRefused: both(
    'Aqara refused the keys of the project (App ID, Key ID, App Key): nothing is sent with them again; check them or click "Test the connection"',
    'Aqara a refusé les clés du projet (App ID, Key ID, App Key) : plus rien n’est envoyé avec elles ; vérifiez-les ou cliquez sur « Tester la connexion »',
  ),
  grantRefused: both(
    'Aqara refused the renewal of the authorization: authorize again ("Send the verification code", then "Authorize")',
    'Aqara a refusé le renouvellement de l’autorisation : autorisez à nouveau (« Envoyer le code de vérification », puis « Autoriser »)',
  ),
  tokensNotSaved: both(
    'The renewed tokens could not be saved in Gladys yet (used meanwhile; saved again at the next read)',
    'Les jetons renouvelés n’ont pas encore pu être enregistrés dans Gladys (utilisés en attendant ; nouvel essai à la prochaine lecture)',
  ),
  paused: (ms) =>
    both(
      `Aqara asked to slow down or is failing: reads paused for ${age(ms)}`,
      `Aqara demande de ralentir ou est en panne : lectures en pause pendant ${age(ms)}`,
    ),
  budgetSpent: (calls) =>
    both(
      `The daily budget of ${calls} API calls is spent: reads resume tomorrow (UTC); turning off and closing still work`,
      `Le budget quotidien de ${calls} appels d’API est épuisé : les lectures reprennent demain (UTC) ; éteindre et fermer marchent toujours`,
    ),
  partlyRead: both(
    'Some device descriptions could not be read (tried again later)',
    'Certaines descriptions d’appareils n’ont pas pu être lues (nouvel essai plus tard)',
  ),
  failure: (kind, code) => {
    const text = kindText(kind, code);
    return both(`Aqara not read: ${text.en}`, `Aqara non lu : ${text.fr}`);
  },
  storeUnreadable: both(
    'The /data folder of the integration cannot be read: read again every 10 s',
    'Le dossier /data de l’intégration est illisible : relu toutes les 10 s',
  ),
  stopLost: (names) =>
    both(
      `Not confirmed by Aqara: turning off or closing ${names.join(', ')}`,
      `Non confirmé par Aqara : extinction ou fermeture de ${names.join(', ')}`,
    ),
  reading: both('Reading Aqara…', 'Lecture d’Aqara…'),
  testTooSoon: (ms) =>
    both(`Next read possible in ${age(ms)}`, `Prochaine lecture possible dans ${age(ms)}`),
  testOk: (devices, left) => {
    const lines = devices
      .slice(0, 30)
      .map((d) => `${d.name} (${d.model}): ${d.features}`)
      .join('; ');
    return both(
      `Connected: ${devices.length} devices${lines ? ` — ${lines}` : ''}. API calls left today: ${left}`,
      `Connecté : ${devices.length} appareils${lines ? ` — ${lines}` : ''}. Appels d’API restants aujourd’hui : ${left}`,
    );
  },
  codeSent: both(
    'Aqara sends a verification code to the account (e-mail or SMS), valid 10 minutes: enter it below and click "Authorize"',
    'Aqara envoie un code de vérification au compte (e-mail ou SMS), valable 10 minutes : saisissez-le ci-dessous et cliquez sur « Autoriser »',
  ),
  codeTooSoon: (ms) =>
    both(
      `A code was asked less than a minute ago: wait ${age(ms)}`,
      `Un code a été demandé il y a moins d’une minute : attendez ${age(ms)}`,
    ),
  codeTooOften: both(
    'Aqara says codes were asked too often: wait a few minutes',
    'Aqara indique que des codes ont été demandés trop souvent : attendez quelques minutes',
  ),
  accountRefused: both(
    'Aqara does not know this account (or its format)',
    'Aqara ne connaît pas ce compte (ou son format)',
  ),
  codeInvalid: both(
    'Enter the verification code received (letters and digits)',
    'Saisissez le code de vérification reçu (lettres et nombres)',
  ),
  codeRefused: both(
    'Aqara refused the verification code (wrong or older than 10 minutes): ask a new one',
    'Aqara a refusé le code de vérification (erroné ou de plus de 10 minutes) : demandez-en un nouveau',
  ),
  authorizing: both('An authorization is in progress', 'Une autorisation est en cours'),
  authorized: both(
    'Authorized: the tokens are saved in Gladys; the devices are read now',
    'Autorisé : les jetons sont enregistrés dans Gladys ; les appareils sont lus maintenant',
  ),
  actionFailed: (detail) =>
    both(
      `Aqara did not accept the request (${detail})`,
      `Aqara n’a pas accepté la requête (${detail})`,
    ),
  notConfigured: both('The integration is not configured', 'L’intégration n’est pas configurée'),
  invalidValue: both('Invalid value', 'Valeur invalide'),
  notKnown: both(
    'Device or value unknown to the last read of Aqara',
    'Appareil ou valeur inconnu de la dernière lecture d’Aqara',
  ),
  notCommandable: both(
    'This value is read only (Aqara does not let it be written, or this device type stays read only)',
    'Cette valeur est en lecture seule (Aqara ne permet pas de l’écrire, ou ce type d’appareil reste en lecture seule)',
  ),
  offline: both('The device is offline for Aqara', 'L’appareil est hors ligne pour Aqara'),
  listOld: both(
    'The device list of Aqara is too old (no read for 15 minutes)',
    'La liste des appareils d’Aqara est trop ancienne (aucune lecture depuis 15 minutes)',
  ),
  storeCommand: both(
    'The /data folder cannot be read: only turning off and closing are sent',
    'Le dossier /data est illisible : seuls éteindre et fermer sont envoyés',
  ),
  pausedCommand: both(
    'Aqara asked to slow down: only turning off and closing are sent during the pause',
    'Aqara demande de ralentir : seuls éteindre et fermer sont envoyés pendant la pause',
  ),
  supersededByStop: both(
    'Not sent: a turn off or a close came after it',
    'Non envoyé : une extinction ou une fermeture est arrivée après',
  ),
  notSentCommand: (kind) => {
    const text = kindText(kind);
    return both(`Nothing sent (${text.en})`, `Rien envoyé (${text.fr})`);
  },
  failedCommand: (detail) =>
    both(`Aqara refused the command (${detail})`, `Aqara a refusé la commande (${detail})`),
  sent: both(
    'Sent; confirmed by the reads 5 s and 20 s later',
    'Envoyé ; confirmé par les lectures 5 s et 20 s plus tard',
  ),
  sentNoAnswer: both(
    'Sent, without confirmation yet (read again in 5 s)',
    'Envoyé, sans confirmation pour l’instant (relu dans 5 s)',
  ),
  stopNotSent: both(
    'Nothing sent yet: tried again every 10 s for 2 minutes',
    'Rien envoyé pour l’instant : nouvel essai toutes les 10 s pendant 2 minutes',
  ),
  stopRefused: (detail) => both(`Aqara refused it (${detail})`, `Aqara l’a refusé (${detail})`),
  stopNoConfig: both(
    'Waiting for the configuration: sent as soon as it is read (within 2 minutes)',
    'En attente de la configuration : envoyé dès qu’elle est lue (sous 2 minutes)',
  ),
  stopNoKeys: both(
    'Nothing sent: the keys of the project are missing',
    'Rien envoyé : les clés du projet manquent',
  ),
  stopNoGrant: both(
    'Nothing sent: the integration is not authorized',
    'Rien envoyé : l’intégration n’est pas autorisée',
  ),
  stopRefusedAuth: both(
    'Nothing sent: Aqara refused the keys or the authorization',
    'Rien envoyé : Aqara a refusé les clés ou l’autorisation',
  ),
  stopNoTarget: both(
    'Nothing sent: this value is not known yet (no read of Aqara since the start)',
    'Rien envoyé : cette valeur n’est pas encore connue (aucune lecture d’Aqara depuis le démarrage)',
  ),
};
