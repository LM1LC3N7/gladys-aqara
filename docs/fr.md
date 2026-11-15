# Aqara (API ouverte Aqara)

Amène dans Gladys les appareils de votre compte Aqara : les hubs (M2, M3,
M1S…) et ce qui leur est appairé — capteurs de température, d’humidité et de
pression, capteurs de porte et de fenêtre, détecteurs de fuite, de présence,
de fumée et de CO, prises, lumières et rideaux. Par l’**API ouverte Aqara**
officielle (le cloud), avec un projet développeur à vous. Intégration non
officielle, sans lien avec Aqara, jamais testée avec un vrai
appareil : dites-nous ce qui marche et ce qui ne marche pas.

## 1. Créer un projet développeur

1. Connectez-vous sur <https://developer.aqara.com/> avec un compte Aqara
   (celui de votre app Aqara Home convient).
2. Console, **Project Management**, **New project** ; attendez son
   approbation.
3. Dans le détail du projet : l’**App ID** ; dans **Key Management** : le
   **Key ID** et l’**App Key**.

Copiez ces trois valeurs dans la configuration et choisissez le **serveur**
de votre compte Aqara (Europe, États-Unis, Chine continentale, Corée du Sud,
Russie, Singapour : celui choisi dans l’app Aqara Home). L’App Key est gardée
par Gladys dans sa base, jamais réaffichée ; elle sert seulement à signer les
requêtes (signature MD5 de la documentation) et ne sort jamais elle-même de
l’intégration.

## 2. Autoriser votre compte Aqara

1. Saisissez l’adresse e-mail ou le numéro de téléphone du compte Aqara qui
   possède les appareils, et enregistrez.
2. Cliquez sur **Envoyer le code de vérification** : Aqara envoie un code de
   vérification à ce compte (e-mail ou SMS), valable 10 minutes. Un code
   n’est demandé que sur votre clic, jamais au démarrage ni par une lecture,
   et jamais deux fois en moins d’une minute.
3. Saisissez le code dans le bouton **Autoriser** et cliquez. Les deux jetons
   (accès et renouvellement) sont remplis dans la configuration par
   l’intégration.

Le jeton d’accès est demandé pour 7 jours et renouvelé avec le jeton de
renouvellement un jour avant son expiration (ou quand Aqara le dit expiré) ;
les jetons renouvelés sont enregistrés dans la configuration de Gladys. Si
Aqara refuse le renouvellement (jeton expiré 30 jours de plus sans lecture,
ou révoqué), le statut dit « autorisez à nouveau » : plus rien n’est envoyé
avec ces jetons tant que vous n’avez pas autorisé à nouveau.

Les clés, les jetons, le compte et le code ne sont jamais écrits dans les
journaux, le statut ni `/data`.

## Appareils

La **Découverte** propose chaque appareil qui a au moins une des valeurs
ci-dessous, d’après la description « trait » qu’Aqara donne de son modèle :

| Trait Aqara                                                                        | Gladys                                   | Commandé |
| ---------------------------------------------------------------------------------- | ---------------------------------------- | -------- |
| OnOff d’une lumière                                                                | marche/arrêt de lumière                  | oui      |
| CurrentLevel d’une lumière (%)                                                     | luminosité 0-100                         | oui      |
| OnOff d’une prise ou d’un interrupteur                                             | interrupteur marche/arrêt                | oui      |
| CurrentPositionPercentage / TargetPositionPercentage                               | position de rideau (0 fermé, 100 ouvert) | oui      |
| CurrentTemperature (°C), CurrentHumidity (%), CurrentPressure (kPa)                | capteurs                                 | non      |
| CurrentIlluminance (lux), CO2Density (ppm), PM2.5Density (µg/m³), VOCDensity (ppb) | capteurs                                 | non      |
| BatPercentRemaining (%)                                                            | batterie                                 | non      |
| CurrentPower (W), CurrentVoltage (V), CircuitCurrent (A)                           | puissance, tension, intensité            | non      |
| ContactSensorState                                                                 | capteur d’ouverture                      | non      |
| LeakState, Occupancy, SmokeDetected, CODetected                                    | fuite, présence, fumée, CO               | non      |

Une valeur dans une autre unité que celle listée, hors de sa plage, ou un
texte, est inconnue : elle n’est jamais publiée (jamais comme 0). Un appareil
hors ligne (Reachable faux) ne publie rien. Une mesure est publiée une fois
par date source, jamais si elle a plus de 2 heures (une valeur sans date
source est publiée tant que l’appareil est en ligne) ; marche/arrêt, positions
et détecteurs sont publiés comme l’état courant.

**En lecture seule dans cette version** : serrures, caméras, sonnettes,
portes de garage, vannes, pompes, ouvre-fenêtres, chauffage et climatisation :
un appareil de l’un de ces types n’est jamais écrit, même ses autres valeurs
(une serrure n’est jamais ouverte). Le compteur d’énergie
(CumulativeEnergyConsumption), couleurs et température de couleur, boutons
et cubes (événements seulement) ne sont pas encore gérés.

Hypothèse à vérifier sur un vrai appareil : un capteur d’ouverture « vrai »
signifie ouvert, sauf si la description Aqara du modèle nomme les valeurs
(Open / Close).

## Commandes

- **Éteindre** (marche/arrêt 0, luminosité 0) et **fermer un rideau**
  (position 0) partent tout de suite, pendant une pause demandée par Aqara,
  au-delà du budget quotidien, avant que la liste des appareils soit relue
  (juste après un redémarrage, les paramètres d’appareil de Gladys disent où
  écrire), et quand `/data` est illisible. Une lecture en cours est coupée
  pour eux. Refus d’un arrêt : pas encore de configuration (gardé 2 minutes,
  envoyé dès qu’elle est lue), clés ou jetons absents, clés ou autorisation
  refusées par Aqara pendant cette exécution, valeur en lecture seule, valeur
  pas encore connue (aucune lecture depuis le démarrage et pas de paramètres
  d’appareil dans Gladys). Il est
  confirmé par les lectures 5 s et 20 s plus tard ; contredit (ancienne
  valeur sans date source plus récente), il est renvoyé, deux fois au plus ;
  changé après lui (date source plus récente : l’app Aqara, un interrupteur
  mural, une automatisation), il n’est pas renvoyé. Un envoi qui n’a pas pu
  partir (réseau, 429, 5xx, appareil hors ligne) est réessayé toutes les
  10 s, 6 fois en 2 minutes.
- **Allumer, une luminosité, une position de rideau au-dessus de 0** sont
  refusés pendant une pause, au-delà du budget, quand la liste des appareils
  a plus de 15 minutes, quand l’appareil est hors ligne ou la valeur en
  lecture seule. Envoyés, ils sont confirmés de la même façon (lectures 5 s
  et 20 s plus tard). Une commande en file avant une extinction du même
  point d’accès ne part jamais après elle.

Aqara n’a pas de « stop » de rideau dans son modèle de traits : seule la
position est proposée.

## Lectures et quota

Chaque lecture coûte un appel par tranche de 50 valeurs, plus la liste des
appareils toutes les 10 minutes et les descriptions des nouveaux modèles.
Par défaut toutes les 120 s (60 s au moins). Le **budget quotidien** (3000
appels par défaut, jour UTC) est compté avant chaque appel et gardé au
redémarrage : une fois épuisé, les lectures s’arrêtent jusqu’au lendemain ;
éteindre et fermer partent toujours. Réglez-le sous le quota de votre projet.
Un 429, ou un serveur occupé pendant une lecture (codes 100, 104, 5xx), met
tout en pause sauf les arrêts (un 5xx en réponse à une commande ne met rien en
pause), 1 minute doublée jusqu’à 6 heures (ou le Retry-After s’il est
plus long), gardée au redémarrage. Une seule requête de lecture à la fois.

Refus : les clés refusées (codes 106, 107, 2002…) arrêtent tout jusqu’à ce
que vous les changiez ou cliquiez sur **Tester la connexion** (qui essaie
toujours) ; une autorisation refusée sur une route (2008, 403…) n’est jamais
prise pour un refus des clés.

## Dépannage

- « a refusé les clés du projet » : vérifiez App ID, Key ID, App Key et le
  serveur ; un projet pas encore approuvé est refusé aussi.
- « Aqara a refusé la date de la requête » : l’horloge de l’hôte de Gladys
  est fausse.
- « une autorisation refusée (restriction d’adresse IP du projet ?) » : les
  réglages IP du projet n’autorisent que d’autres adresses.
