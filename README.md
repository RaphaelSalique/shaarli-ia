## Shaarli Quick Share Extension

Extension Firefox/Chrome pour partager rapidement la page courante sur une instance Shaarli auto‑hébergée, avec :

- Récupération automatique du titre/URL de l’onglet actif.
- Résumé généré par le fournisseur IA de votre choix (Mistral ou Gemini) via le prompt demandé.
- Tags proposés via l’endpoint REST `GET /api/v1/tags`, pondérés par 15 suggestions générées par l’IA (français ou anglais selon le contexte) pour mettre en avant les tags déjà existants et pertinents pour la page courante.
- Publication via l’API Shaarli avec visibilité configurable (public/privé).

### Structure

```
extension-firefox/      # build Manifest V2 pour Firefox (background script persistant)
extension-chrome/       # build Manifest V3 pour Chromium (service worker)
  manifest.json
  background.js         # appels réseau (IA, Shaarli, tags)
  popup/                # UI popup d’action
  options/              # page d’options (URL, token, clés IA…)
  icons/                # pictos 16/48/128
```

### Configuration

1. Firefox : chargez `extension-firefox/` via `about:debugging` (`Cette instance de Firefox` → « Charger un module complémentaire temporaire… » → `manifest.json`). Chromium : activez le mode développeur dans `chrome://extensions` puis cliquez sur « Charger l’extension non empaquetée… » et pointez `extension-chrome/` (Manifest V3, service worker).
2. Ouvrez la page d’options (icône ⚙ depuis la popup ou bouton “Options” du navigateur) et remplissez :
   - **URL Shaarli** : racine publique, ex. `https://raphael.salique.fr/liens/`.
   - **Secret REST API Shaarli** : valeur affichée dans « Outils > API » ; l’extension forge automatiquement un JWT (`HS512`) à partir de ce secret pour l’envoyer dans l’en-tête `Authorization: Bearer <token>`.
   - **Fournisseur IA + clé API** : choisissez Mistral ou Gemini et renseignez la clé associée pour générer les résumés.
   - **Visibilité par défaut** : public (défaut) ou privé.
3. (Optionnel) Adaptez la logique de filtrage/concordance des tags dans `popup/popup.js` si vous souhaitez d’autres heuristiques que celles basées sur le résumé IA.

### Utilisation

1. Cliquer sur l’icône de l’extension ouvre la popup pré-remplie avec titre/URL.
2. Bouton « Résumé IA » :
   - Récupère un extrait du `document.body` de l’onglet.
   - Envoie le prompt requis au fournisseur IA sélectionné.
   - Insère la réponse dans la description.
3. Bouton « Tags cloud » interroge directement `GET /api/v1/tags` (API Shaarli) après avoir obtenu le résumé IA et ne suggère que les tags existants jugés pertinents vis‑à‑vis de ce résumé.
4. Bouton « Partager » envoie la requête `POST /api/v1/links` avec les champs requis, les tags, et la visibilité (privé = `true`).
5. Une notification textuelle s’affiche dans la popup (succès/erreur).
6. Sur Chrome, assurez-vous d’avoir accordé les autorisations demandées lors du chargement MV3 ; sur Firefox, l’accord des permissions `websiteContent`/`browsingActivity` est géré par l’invite d’installation.

### Prérequis côté Shaarli

- Activer l’API REST et générer un secret (`config[api.secret]` > menu Outils > API). Ce secret ne doit pas être pré-signé : l’extension se charge de fabriquer les JWT courts requis par Shaarli.
- Le token est stocké localement dans `browser.storage.local`. Supprimez-le via les options si nécessaire.
- L’API doit accepter l’entête `Authorization: Bearer <secret>` (comportement par défaut de Shaarli REST). Adaptez `shareLinkToShaarli` si vous préférez utiliser des cookies de session.

### Tests rapides

- `manifest.json` est auto-chargeable : vérifier qu’aucune permission facultative n’apparaît comme manquante.
- Tester le flux complet :
  1. Configurer les options.
  2. Ouvrir une page web classique.
  3. Générer le résumé.
  4. Sélectionner quelques tags.
  5. Partager et vérifier que le lien apparaît côté Shaarli.
- Scénarios d’erreur couverts dans l’UI : absence de config, erreur réseau IA/Shaarli, tags introuvables.

### Limitations connues

- Le résumé repose sur le texte `innerText` tronqué à ~6 000 caractères ; les pages très lourdes peuvent nécessiter un ajustement.
- Les tags reposent désormais exclusivement sur l’API Shaarli : si l’instance désactive l’API ou restreint le token, il faudra adapter `fetchTagsFromApi`.
- La génération du JWT nécessite `crypto.subtle` + `TextEncoder` (Web Crypto). Si vous utilisez un navigateur très ancien ou un environnement verrouillé qui ne les expose pas aux extensions MV2, le bouton « Tags cloud » retournera une erreur d’authentification.
- Les suggestions pertinentes s’appuient sur une correspondance lexicale simple entre résumé/titre et tags existants ; adaptez `rankTagsByRelevance` si vous avez besoin d’une approche plus avancée (embeddings, LLM, etc.).
- Chaque fournisseur IA impose ses propres quotas/coûts/latences ; assurez-vous de disposer des clés API nécessaires et d’un plan adapté.
- Aucun chiffrement local des secrets n’est appliqué (limitation structurelle WebExtension). Limitez l’accès physique à la machine.
