# Contributing

Thanks for wanting to help! This is a small fan project, so everything is simple.

## Reporting a problem or suggesting something
Use the [issue forms](https://github.com/SnailMango/sulfur-interactive-cookbook/issues/new/choose). If a recipe, heal value or buff looks wrong, first check <https://sulfur.wiki.gg>: the data comes from there, so fixing it on the wiki fixes it here too (after the next weekly refresh).

## Adding a language
Yes, more languages are welcome. What a language needs:

| Part | Where | Effort |
|---|---|---|
| Interface texts (buttons, section titles, messages) | the `S` table at the top of the `<script>` in `renderer/index.html` - copy the `en` block and translate it | easy |
| Item names | edited in the app (✎) and stored in `it_en.json`-style files; ideally taken from the game's own localisation files | medium |
| Effect lines ("Gives 20 health over 10 seconds", "Removes Poisoned"…) | rule-based translator `trEffect` + glossary in `src/defaults.json` | medium - currently written for Italian |

The translator and glossary are currently Italian-specific. When a second language is requested, they will be moved into a `locales/` folder with one file per language so that adding a language never requires touching the code. **If you want to be that second language, open a [translation request](https://github.com/SnailMango/sulfur-interactive-cookbook/issues/new?template=translation_request.yml)** and we will do it together.

## Running the project locally
Requires [Node.js](https://nodejs.org) 20+.

```bash
npm install
npm start
```

To rebuild the data file from the wiki: `python tools/scrape.py` (Python 3.8+, standard library only).

## Pull requests
Keep them small and focused, describe what you changed and how you tested it. The code is plain JavaScript/Python with no build step for the interface.
