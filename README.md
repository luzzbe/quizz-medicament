# Quiz médicaments

Quiz statique de révision pharmacologique orienté IDE.

L'application mélange les questions sur les noms commerciaux, les DCI, les classes pharmacologiques et les exemples de classe à partir d'un dataset généré depuis BDPM et Open Medic.

## Développement

Ouvrir `index.html` directement dans un navigateur, ou lancer un serveur local :

```sh
python3 -m http.server 4173
```

## Données

Le dataset est généré avec :

```sh
node scripts/build-dataset.mjs
```

Variables utiles :

- `OPENMEDIC_YEAR` : année Open Medic, défaut `2024`.
- `MIN_BOITES_DC` : seuil de boîtes remboursées par nom commercial, défaut `50000`.
- `QUIZ_TOP_N` : nombre de médicaments conservés pour le quiz, défaut `320`.
