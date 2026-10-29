# Zotero2Anki

A Zotero plugin that turns text you select or highlight in Zotero's PDF reader into Anki cards. Cards are edited in a sidebar panel and sent to a deck you choose through [AnkiConnect](https://ankiweb.net/shared/info/2055492159).

Supports Zotero 7–10.

## Features

- **＋ Anki** button in the reader's text-selection popup sends the selection to the card editor.
- **Send to Anki panel** in the right-click menu of existing highlights. The annotation's comment becomes the starting question.
- **Anki card** section in the reader's right sidebar:
  - Deck picker, loaded live from Anki
  - Basic or Cloze cards, switchable per card
  - **Cloze selection** button (Ctrl/Cmd+Shift+C) wraps selected words in the next `{{cN::…}}`
  - Optional source line (author, year, title, page) with an "Open in Zotero" link back to the page
  - Tags, **Add card** (Ctrl/Cmd+Enter) and **Clear**
  - A separate draft per paper; sending several selections appends them to the same card
- Detects Anki's actual note types and field names, so it also works with non-English Anki or renamed note types.
- Sent annotations get an `anki` tag in Zotero (optional).

## Requirements

- Zotero 7, 8, 9 or 10
- Desktop Anki with the **AnkiConnect** add-on (code `2055492159`), running while you make cards

## Install

1. Build the plugin (below), or download a release `.xpi`.
2. In Zotero, go to **Tools → Plugins → gear icon → Install Plugin From File…** and choose the `.xpi`.
3. Open **Settings → Zotero2Anki**, click **Test connection**, and pick a default deck.

## Build

```sh
./build.sh
```

This zips `src/` into `build/zotero2anki-<version>.xpi`, taking the version from `src/manifest.json`.

## Project layout

```
src/
  manifest.json        plugin metadata and Zotero version range
  bootstrap.js         Zotero lifecycle hooks (startup, shutdown, window load)
  zotero2anki.js       main logic: reader hooks, sidebar panel, AnkiConnect calls
  prefs.js             default preferences
  preferences.xhtml    settings pane markup
  preferences.js       settings pane logic
  style.css            sidebar panel styles
  icons/card.svg       sidebar icon
  locale/en-US/        Fluent strings for the sidebar section
```

## Development notes

- When a new major Zotero version ships, raise `strict_max_version` in `src/manifest.json` after testing. Zotero disables plugins outside that range.
- `update_url` in the manifest is a placeholder. Point it at a real `updates.json` to enable automatic updates.
- Debugging: turn on **Help → Debug Output Logging** and look for lines that start with `Zotero2Anki:`.
- If AnkiConnect reports a permission error, click **Test connection** in settings. Anki then asks you to approve Zotero.
