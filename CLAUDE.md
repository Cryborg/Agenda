# Agenda

PWA en JavaScript pur (modules ES), sans dépendance ni build. Voir README.md.

- Lancer : `npm start` (http://localhost:8080). Tests : `npm test` (node:test, sur `js/layout.js` et `js/recur.js`).
- Idée centrale : les événements longs (journée entière ou >= 24 h) sont placés à leur heure réelle dans le bandeau et la vue mois (`bandLayout` dans `js/layout.js`), avec des « rails » dans la grille horaire.
- Les deux sources (`LocalStore`, `GoogleStore`) exposent la même interface : `listCalendars`, `listEvents`, `getSeries`, `createEvent`, `updateEvent(ev, full, changes, scope)`, `deleteEvent(ev, scope)`, `uploadImage(file)`, `fetchImage(att)`. `changes` ne contient que les champs modifiés ; la présence de `start` signifie « horaires modifiés ».
- Personnes assignées : `extendedProperties.private.agendaPeople` (JSON d'un tableau de noms) côté Google. Jamais de participants Google (pas de notification).
- Images : pièces jointes de l'événement (`attachments`, tableau de `{ fileId, title, mimeType, fileUrl, iconLink }`). Google : fichiers Drive (scope facultatif `drive.file`, dossier « Agenda »), toujours avec `supportsAttachments=true`. Local : blobs dans IndexedDB (clés `local:…`). `updateEvent` remplace toute la liste : garder les pièces jointes qui ne sont pas des images.
- Interface sombre uniquement. Pas de tiret cadratin dans les textes affichés.
- Quand on ajoute ou renomme un fichier de l'appli, mettre à jour la liste `SHELL` de `sw.js` et incrémenter `CACHE`.
