# Agenda

Agenda personnel (PWA) synchronisé avec Google Agenda, pensé pour la garde alternée.

## Ce qui change par rapport à Google Agenda

Dans Google Agenda, un événement de plusieurs jours qui commence à 19:00 est affiché en haut, comme une journée entière, avec juste « 19:00 » écrit dessus. Impossible de voir d'un coup d'œil chez qui sont les enfants vendredi à 18:00.

Ici, les événements longs (journée entière, ou horaires de 24 h et plus) sont dessinés **à leur position réelle dans le temps** :

- **Bandeau du haut (vues jour, 3 jours, semaine) et vue mois** : une barre qui commence vendredi à 19:00 démarre aux 19/24 de la case du vendredi. Deux gardes qui se passent le relais à 19:00 partagent la même ligne et se touchent exactement à l'heure du changement. L'heure de début est à gauche de la barre, l'heure de fin à droite.
- **Rails dans la grille horaire** : un trait vertical coloré, à gauche de chaque jour, montre heure par heure l'événement long en cours (désactivable dans les paramètres).
- Un événement court qui passe minuit (concert de 22:00 à 01:00) reste dans la grille, coupé sur les deux jours.

## Autres fonctions

- Vues Jour, 3 jours, Semaine, Mois ; mini-calendrier ; navigation au clavier (`t` aujourd'hui, `j`/`k` ou flèches, `d`/`x`/`w`/`m` pour les vues, `c` pour créer).
- Création par cliquer-glisser dans la grille (ou appui sur un créneau au téléphone), modification, suppression, déplacement vers un autre agenda.
- Événements récurrents : modifier ou supprimer une seule occurrence ou toute la série ; créer une récurrence (quotidienne, hebdomadaire, toutes les 2 semaines, mensuelle, annuelle).
- **Personnes assignées** : tu peux assigner un événement à une ou plusieurs personnes, puis filtrer l'affichage par personne (l'œil à côté d'un nom n'affiche qu'elle). Ce ne sont **pas** des invités Google : personne n'est invité ni notifié. L'information est rangée dans une propriété privée de l'événement (`extendedProperties.private.agendaPeople`), donc elle suit l'événement sur tous tes appareils. Seules les personnes qui ont déjà accès à l'agenda concerné pourraient la lire via l'API, et Google Agenda ne l'affiche nulle part.
- Mode local (sans compte Google) avec des exemples, dont une garde alternée : pratique pour essayer.
- Installable sur téléphone et ordinateur (PWA), s'ouvre hors ligne avec les derniers événements chargés.
- Interface sombre uniquement.

## Lancer en local

Aucune dépendance, aucun build. Il faut juste Node.js.

```powershell
npm start
```

Puis ouvrir http://localhost:8080. Tests : `npm test`.

## Connecter Google Agenda (une seule fois, environ 10 minutes)

L'appli parle directement à l'API Google Calendar depuis ton navigateur. Il te faut ton propre « ID client OAuth » (gratuit) :

1. Va sur https://console.cloud.google.com/ et crée un projet (par exemple « Agenda »).
2. **API et services > Bibliothèque** : cherche « Google Calendar API » et clique sur **Activer**.
3. **Google Auth Platform** (ou « Écran de consentement OAuth ») :
   - Type d'utilisateur : **Externe**, nom de l'appli « Agenda », ton adresse e-mail.
   - **Accès aux données** : ajoute les champs d'application
     `.../auth/calendar.events` et `.../auth/calendar.calendarlist.readonly`.
   - **Audience > Utilisateurs de test** : ajoute ton adresse Gmail. L'appli peut rester en mode « Test », c'est suffisant pour un usage perso.
4. **Clients > Créer un client** : type **Application Web**.
   - **Origines JavaScript autorisées** : ajoute `http://localhost:8080` et, si tu la publies, l'adresse de ta version en ligne (ex. `https://tonpseudo.github.io`). L'origine exacte est affichée dans les paramètres de l'appli, avec un clic pour la copier.
   - Pas besoin d'URI de redirection.
5. Copie l'**ID client** (`xxxx.apps.googleusercontent.com`), ouvre l'appli, bouton **Paramètres** (roue dentée), colle-le et enregistre.
6. Clique sur **Connecter Google Agenda** dans la barre latérale. Google affichera un avertissement « appli non validée » : c'est normal pour une appli perso en mode Test, clique sur *Continuer*.

L'ID client n'est pas un secret : il ne donne accès à rien sans ta connexion.

### À savoir sur la connexion

Sans serveur, Google ne délivre que des jetons d'une heure. Quand il expire, un bandeau propose **Se reconnecter** (un clic, la fenêtre Google se ferme toute seule). Les événements restent affichés en attendant. Pour une connexion permanente, il faudrait ajouter un petit serveur (flux « code d'autorisation » avec jeton de rafraîchissement).

## Mettre en ligne (pour l'utiliser sur le téléphone)

Le site est 100 % statique, avec des chemins relatifs. Avec GitHub Pages :

1. Pousse le dépôt sur GitHub.
2. **Settings > Pages** : source « Deploy from a branch », branche `main`, dossier `/ (root)`.
3. Ajoute `https://tonpseudo.github.io` aux origines JavaScript autorisées de l'ID client.
4. Sur le téléphone, ouvre l'adresse dans Chrome puis menu **Ajouter à l'écran d'accueil**.

## Organisation du code

| Fichier | Rôle |
| --- | --- |
| `js/layout.js` | Placement des événements (bandeau proportionnel, rails, colonnes). Sans DOM, testé. |
| `js/recur.js` | Règles de récurrence (préréglages, expansion pour le mode local). |
| `js/store-google.js` | Connexion OAuth (Google Identity Services) et API Calendar v3. |
| `js/store-local.js` | Agenda local stocké dans le navigateur, même interface que Google. |
| `js/people.js` | Registre local des personnes (noms, couleurs). |
| `js/app.js` | Interface : vues, éditeur, filtres, synchro. |
| `sw.js` | Service worker (hors ligne). |
