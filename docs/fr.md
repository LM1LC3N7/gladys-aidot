# AiDot

Intègre à Gladys les **lumières Wi-Fi AiDot** (Linkind, OREiN et les autres
marques installées avec l’application AiDot) : marche / arrêt, intensité,
couleur et température de couleur, et les changements envoyés par les lumières
(application, interrupteur, programmations) affichés aussitôt.

> Jamais testé avec un vrai appareil : dites-nous sur le forum comment ça se
> passe. Sans lien avec AiDot.

## Fonctionnement

- **Le cloud AiDot, pour la liste seulement.** Avec l’e-mail et le mot de passe
  de votre compte AiDot, l’intégration lit la liste de vos lumières : leur nom,
  leur modèle, leur adresse sur votre réseau et les clés locales dont chaque
  lumière a besoin. Elle se connecte comme le fait python-aidot, la
  bibliothèque du fabricant lui-même (celle qu’utilise Home Assistant) : avec
  l’**identifiant d’application de cette bibliothèque**. Louis, qui maintient
  ces intégrations, l’a accepté pour cette intégration seulement, le
  2026-11-05. Rien d’autre n’imite une application.
- **Votre réseau, pour tout le reste.** Chaque lumière ajoutée dans Gladys est
  pilotée directement sur votre réseau (port TCP 10000, AES avec la clé de la
  lumière) : aucune commande ne passe par le cloud. L’adresse vient du cloud ;
  quand elle manque ou n’est plus bonne, une demande de découverte est
  diffusée par Gladys lui-même (UDP 6666, comme le fait l’application AiDot)
  pour la retrouver. Comme dans l’application AiDot, cette demande porte
  l’identifiant de votre compte AiDot vers tous les appareils de votre réseau
  local (sous la clé publique du protocole).
- Le mot de passe, les jetons de la session, votre identifiant d’utilisateur et
  les clés des lumières ne sont jamais écrits dans un journal, le statut ou le
  dossier `/data` de l’intégration ; les jetons et les clés restent en mémoire.

## Configuration

1. **E-mail** et **mot de passe** du compte AiDot (ceux de l’application). Le
   mot de passe est gardé par Gladys dans sa base, jamais réaffiché, et envoyé
   seulement au cloud AiDot quand l’intégration se connecte.
2. **Pays du compte** : celui choisi à la création du compte ; il désigne le
   cloud AiDot (Europe, Amérique ou Asie).
3. **Intervalle de lecture** : la fréquence de lecture de chaque lumière sur le
   réseau (60 s par défaut, 30 s au moins). Les changements envoyés par la
   lumière arrivent aussitôt entre deux lectures.
4. Enregistrez, puis ouvrez **Découverte** : chaque lumière qui a une clé
   locale y figure avec son nom dans l’application AiDot. Ajoutez celles que
   vous voulez : seules les lumières ajoutées sont connectées.

**Tester la connexion** se connecte au cloud AiDot avec les identifiants
enregistrés (même après un refus, toutes les 10 s au plus, jamais pendant une
demande d’attente d’AiDot) et lit la liste des lumières.

## Le cloud, poliment

- La liste est lue au démarrage, toutes les 6 heures et à la **Découverte**,
  jamais moins d’une minute après la lecture précédente (redémarrage compris :
  l’heure de chaque essai est gardée dans `/data`). De nouveaux identifiants
  enregistrés et **Tester la connexion** (toutes les 10 s au plus) n’attendent
  pas cette minute.
- **E-mail ou mot de passe refusé** : seule la connexion au compte peut le
  dire. Le refus est gardé (dans `/data` : une empreinte du compte et une marque
  à 64 valeurs du mot de passe, jamais le mot de passe) et **le mot de passe
  n’est jamais renvoyé de lui-même**, redémarrage compris, tant que vous
  n’enregistrez pas d’autres identifiants ou ne cliquez pas sur **Tester la
  connexion**. Aucune autre erreur du cloud (une session non acceptée, une
  réponse illisible) n’est prise pour un refus : la session est renouvelée, et
  la lecture réessayée plus tard.
- **AiDot demande d’attendre** (HTTP 429 ou 5xx) : le cloud est laissé
  tranquille 60 s, doublées jusqu’à 6 h (ou ce que demande AiDot, dans ces
  bornes), gardé au redémarrage. Injoignable : nouveaux essais après 1, 2, 5,
  15, 30 min, puis toutes les heures.
- Rien de tout cela n’arrête les lumières déjà connues : elles sont pilotées
  sur le réseau.

## Appareils

| Lumière AiDot                        | Fonctionnalités                                    |
| ------------------------------------ | -------------------------------------------------- |
| Toutes                               | Allumage (0 / 1), intensité (0 à 100, 0 = éteint)  |
| Couleur (`control.light.rgbw`)       | + couleur, température de couleur (2700-6500 K)    |
| Blanc réglable (`control.light.cct`) | + température de couleur, dans la plage du produit |

Une couleur, une température ou une intensité allume aussi la lumière. Une
température hors de la plage de la lumière, ou une couleur sur une lumière
blanche, est refusée avant tout envoi.

## Envoi des commandes

- Une connexion par lumière, un message à la fois dessus. Une commande est
  réussie quand la lumière montre le nouvel état après elle (répondue par la
  lumière, ou changée par rapport à avant) ; sinon son message dit pourquoi
  (« envoyée, sans confirmation », « montre un autre état », « refusée par la
  lumière ») et la lumière est relue 5 s plus tard.
- Une scène sur plusieurs lumières les règle toutes : une commande qui attend
  encore sa connexion après 3,5 s le dit et part quand même sous 30 s ; les
  commandes d’une même lumière en attente sont fusionnées.

## Éteindre (arrêt)

Un arrêt (allumage 0, ou intensité 0) ne demande aucune option et passe en
premier : il annule les commandes de cette lumière encore en attente (aucune ne
part après lui), coupe une requête restée sans réponse 1 s, et, **une fois la
lumière connue** (sa clé en mémoire), part quoi que dise le cloud (un refus,
une pause, injoignable) et même si la configuration ne peut pas être lue.

Quand il ne peut pas partir, il est **gardé** (aussi au redémarrage) et renvoyé
toutes les 10 s, aussitôt qu’une connexion à la lumière s’ouvre, et dès que le
cloud donne la lumière. Envoyé, il est vérifié par une lecture juste après :
éteinte, c’est fait ; encore allumée (une lecture ou un compte rendu de la
lumière) alors que la lumière l’a répondu, il est renvoyé 10 s plus tard. Il
prend fin quand la lumière se montre éteinte, quand une commande plus récente de
cette lumière part, ou quand l’appareil est supprimé dans Gladys.

**Après un redémarrage, rien n’est pilotable avant la première lecture du
cloud**, arrêt compris : les clés des lumières ne sont jamais écrites dans
`/data`, elles viennent d’abord du cloud. Cette lecture a lieu une minute au
plus après le dernier essai en temps normal. Pour un arrêt gardé, une demande
d’attente d’AiDot est attendue 10 minutes au plus et un cloud injoignable est
réessayé toutes les minutes. L’arrêt ne peut pas partir tant que les
identifiants sont refusés (jusqu’à ce que vous les corrigiez ou cliquiez sur
**Tester la connexion**), tant que le cloud ne répond pas, ou tant que la
configuration ne peut pas être lue depuis Gladys : le statut dit lequel.

Un arrêt n’est refusé que s’il est remplacé par un clic plus récent sur la même
lumière avant de partir. Une fois répondu 4 fois par la lumière sans qu’elle se
montre éteinte, il n’est plus renvoyé de lui-même : le statut le dit ;
recliquez sur Arrêt.

## Statut

La page Configuration montre l’état du cloud (connecté, refusé, demande
d’attente, injoignable), le nombre de lumières, celles joignables sur le
réseau, les lumières à ajouter, et chaque arrêt gardé.

## Dépannage

- « injoignable » : la lumière est coupée au secteur, ou sur un autre réseau que
  Gladys ; nouveaux essais après 5 ou 15 s, puis 30 s, 1, 2, puis toutes les
  5 minutes, et une découverte toutes les 5 minutes au plus.
- « une autre lumière ou une autre clé » : la clé a changé (lumière remise à
  zéro ou réappairée) : la liste est relue depuis le cloud (une minute d’écart au moins, puis le double chaque fois que la clé n’a pas changé).
- Rien dans Découverte : seules les lumières qui ont une clé locale y figurent
  (lumières Wi-Fi de l’application AiDot, dans une maison dont vous êtes
  propriétaire).
