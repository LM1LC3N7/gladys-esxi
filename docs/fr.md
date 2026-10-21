# VMware ESXi

Les hôtes VMware ESXi, seuls ou gérés par un vCenter, dans Gladys, par l’API
vSphere locale (HTTPS, `/sdk`). Pratique pour un homelab :

- chaque **hôte** peut devenir un appareil Gladys : **connecté** (oui /
  non), **mode maintenance**, charge **CPU** et **mémoire** (%), **mémoire
  utilisée** et **totale** (Go), **durée de fonctionnement** (heures),
  **santé** (`green`, `yellow`, `red`, `gray`), **VM en marche**,
  **version** ;
- chaque **datastore** : **accessible**, **occupation** (%), **espace
  libre** et **capacité** (Go) ;
- chaque **machine virtuelle** : **en marche** (oui / non), **état**
  (`poweredOn`, `poweredOff`, `suspended`), **VMware Tools en marche**,
  charge **CPU** (%), **mémoire consommée** (Mo), **durée de
  fonctionnement**, **santé**, et trois boutons : **Démarrer**, **Arrêter
  (invité)**, **Redémarrer (invité)**, inactifs tant que vous ne les
  autorisez pas.

Gladys n’arrête, ne redémarre, ne met en maintenance ni en veille jamais un
hôte, et ne coupe ni ne réinitialise jamais brutalement une VM.

> **Cette intégration n’a jamais été testée avec un vrai hôte ESXi** ni avec
> un vrai vCenter. Cette première version suit l’API vSphere telle que la
> décrit pyVmomi (le SDK officiel) et n’a été testée qu’avec un faux
> serveur. Dites sur le forum Gladys ce qui marche et ce qui ne marche pas,
> avec la version d’ESXi ou du vCenter.

Intégration non officielle, sans lien avec VMware ni Broadcom.

## Avant de commencer

1. **Créez un compte pour Gladys** plutôt que d’utiliser `root`. Sur un ESXi
   seul (Host Client, `https://<hôte>/ui`) : **Hôte**, **Gérer**,
   **Sécurité et utilisateurs**, **Utilisateurs**, **Ajouter un
   utilisateur** ; puis **Hôte**, **Actions**, **Autorisations**, **Ajouter
   un utilisateur** avec le rôle **Lecture seule**. Sur un vCenter : un
   utilisateur de `vsphere.local` (ou de votre annuaire) avec le rôle
   **Lecture seule** à la racine de l’inventaire, propagé.
2. **Seulement si vous voulez les boutons des VM** : donnez au compte un
   rôle qui contient en plus les privilèges **Machine virtuelle,
   Interaction, Mettre sous tension** (Démarrer), **Mettre hors tension**
   (Arrêter) et **Réinitialiser** (Redémarrer), sur les seules VM
   concernées si possible.
3. Avec une **licence ESXi gratuite**, l’API est en lecture seule : les
   lectures fonctionnent, les boutons sont refusés par le serveur
   (« interdit par la licence »).
4. Facultatif : notez l’**empreinte SHA-256** du certificat du serveur
   (affichée par votre navigateur sur son interface web, ou par
   `openssl x509 -noout -fingerprint -sha256 -in /etc/vmware/ssl/rui.crt`
   dans le shell d’ESXi).

## Configuration

- **Adresse de l’hôte ESXi ou du vCenter** : son adresse IP ou son nom
  d’hôte. Une adresse collée depuis un navigateur
  (`https://192.168.1.10/ui/`) est lue comme son hôte et son port. HTTPS
  uniquement (l’API n’existe que là).
- **Port** : vide, 443.
- **Empreinte du certificat** : ESXi utilise un certificat auto-signé
  qu’aucune autorité ne garantit. Vide : Gladys l’apprend à la première
  connexion, par une requête qui ne porte aucun secret, garde son empreinte
  SHA-256 dans son volume `/data`, et n’envoie le mot de passe que sur une
  connexion dont le certificat correspond. Remplie : seul ce certificat est
  accepté, dès la toute première requête. Si le serveur présente plus tard
  un autre certificat (réinstallation, certificat renouvelé, ou autre
  machine à cette adresse), Gladys s’arrête **avant d’envoyer quoi que ce
  soit** et montre l’empreinte SHA-256 de ce certificat dans le statut.
  Enregistrer la configuration ne l’accepte **pas**. Comparez l’empreinte
  avec celle de votre serveur ; si c’est la même, appuyez sur **Faire
  confiance au nouveau certificat** (il épingle exactement le certificat
  montré, puis lit le serveur), ou saisissez cette empreinte dans ce champ.
- **Nom d’utilisateur** et **Mot de passe** : le compte ci-dessus. Le mot de
  passe est gardé par Gladys dans sa base, jamais réaffiché, envoyé
  seulement au serveur. Il est pris tel que vous le tapez (une espace au
  début ou à la fin compte). L’intégration ne l’écrit jamais dans ses
  journaux ni dans `/data`, pas plus que le cookie de session.
- **Rafraîchissement** : la fréquence de lecture du serveur (toutes les
  minutes par défaut). Une requête à chaque fois (quelques-unes de plus pour
  un vCenter avec beaucoup d’objets), et une connexion seulement quand la
  session a expiré.
- **Autoriser le démarrage / l’arrêt / le redémarrage d’une VM** :
  désactivés par défaut (voir plus bas).

Le bouton **Tester la connexion** dit ce que répond le serveur. Comme le
scan de l’onglet Découverte, un redémarrage de Gladys ou de l’intégration, et
la même configuration enregistrée de nouveau, il ne relit le serveur que
quand la dernière tentative est plus ancienne que le rafraîchissement (après
une erreur : que le délai de nouvel essai) ; sinon il donne le dernier
résultat sans requête. Enregistrer la configuration avec d’autres valeurs
relit tout de suite.

## Les valeurs

- **CPU (%)** d’un hôte : le CPU utilisé sur la capacité de ses cœurs ;
  d’une VM : sur la capacité de ses CPU virtuels sur son hôte.
- **Mémoire utilisée** (Go, milliards d’octets) d’un hôte : ce qu’ESXi
  déclare utilisé ; **mémoire consommée** (Mo, millions d’octets) d’une VM :
  la mémoire de l’hôte qu’elle occupe.
- Un hôte que le vCenter ne joint pas ne donne que **connecté** 0, sa santé
  et sa version ; une VM éteinte donne 0 pour son CPU, sa mémoire et sa
  durée de fonctionnement.
- Gladys n’a pas d’unité de pourcentage pour un processeur ou un disque :
  l’unité est dans le nom de la fonction.
- 32 hôtes, 64 datastores et 200 VM au plus sont lus ; les modèles de VM
  sont laissés de côté.
- Pas de déclencheur de scène propre : utilisez les déclencheurs d’appareil
  de Gladys sur **Running**, **Connected** ou **Used (%)** (les fonctions
  portent des noms anglais ; par exemple « Used (%) au-dessus de 90 »).

## Les boutons des VM

Arrêter une VM peut couper un service : un pare-feu, un NAS, un serveur DNS,
Gladys lui-même s’il tourne dans l’une d’elles. Donc :

- chaque bouton refuse tant que son option n’est pas activée ;
- ce sont des boutons, jamais des interrupteurs : un « éteins tout » d’un
  assistant vocal ou d’une scène ne les atteint jamais ;
- avant d’envoyer, Gladys relit la VM et vérifie que c’est la même (son
  UUID d’instance) et son état : **Démarrer** ne fait rien sur une VM en
  marche ; **Arrêter** et **Redémarrer** demandent une VM en marche avec
  VMware Tools en marche (ils demandent au système invité de s’arrêter ou de
  redémarrer proprement : jamais de coupure ni de réinitialisation
  brutale) ; une valeur illisible fait refuser ;
- l’option, la connexion et l’échéance sont revérifiées juste avant l’envoi ;
  quand le serveur est trop lent (3,5 s), rien n’est envoyé et Gladys le
  dit ;
- une action par VM et par minute au plus (même après un redémarrage de
  l’intégration) : une scène en boucle ne peut pas marteler une VM ;
- **Démarrer** n’est confirmé que quand la VM est relue en marche dans le
  délai de réponse ; sinon, et toujours pour **Arrêter** et **Redémarrer**
  (l’invité le fait de lui-même), Gladys répond « envoyé, sans
  confirmation » et relit cette VM 20 secondes plus tard.

## Dépannage

Le statut de connexion de l’intégration dit ce qui se passe :

- **Nom d’utilisateur ou mot de passe refusé** : Gladys s’arrête et ne
  réessaie pas seul, même après un redémarrage (ESXi bloque un compte après
  quelques échecs). Vérifiez-les et enregistrez la configuration.
- **Le serveur accepte la connexion mais refuse les lectures** : il manque
  au compte le rôle Lecture seule ; Gladys réessaie, en espaçant.
- **Certificat HTTPS changé** : voir Empreinte du certificat plus haut (le
  bouton **Faire confiance au nouveau certificat**, jamais un simple
  enregistrement).
- **HTTP 429 ou erreur serveur (5xx)** : toutes les requêtes sont
  suspendues (d’une minute à six heures), et la pause survit à un
  redémarrage. Une erreur SOAP (HTTP 500 avec une réponse de l’API) n’est
  pas une pause.
- **Pas de réponse, mauvaise adresse** : Gladys réessaie, jamais plus vite
  que le rafraîchissement, en attendant plus longtemps à chaque fois
  (jusqu’à 30 minutes).

## Vie privée

Gladys ne garde que ce qu’il affiche. Les noms d’hôte invités, adresses IP et
MAC, annotations et UUID BIOS des VM ne sont jamais demandés. Les noms des
hôtes, datastores et VM vont dans Gladys (ils nomment les appareils), jamais
dans les journaux ni dans `/data`.
