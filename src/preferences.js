/* global Zotero, document */
var Zotero2AnkiPrefs = {
  PREF: "extensions.zotero2anki.",

  get plugin() {
    return Zotero.Zotero2Anki;
  },

  setStatus(msg) {
    let el = document.getElementById("z2a-status");
    if (el) el.value = msg;
  },

  async init() {
    await this.refreshDecks();
  },

  async test() {
    this.setStatus("Connecting…");
    try {
      let version = await this.plugin.anki("version");
      // Ask AnkiConnect to trust Zotero if its CORS settings require it.
      try { await this.plugin.anki("requestPermission"); } catch (e) {}
      let models = await this.plugin.anki("modelNames");
      this.plugin.modelCache = null;
      this.setStatus(`Connected (API v${version}). Note types: ${models.join(", ")}`);
      await this.refreshDecks();
    } catch (e) {
      this.setStatus(e.message);
    }
  },

  async refreshDecks() {
    let menulist = document.getElementById("z2a-deck");
    if (!menulist) return;
    let current = Zotero.Prefs.get(this.PREF + "deck", true) || "";
    menulist.removeAllItems();

    let decks = [];
    try {
      decks = await this.plugin.anki("deckNames");
      decks.sort((a, b) => a.localeCompare(b));
      this.setStatus(`Found ${decks.length} deck${decks.length === 1 ? "" : "s"} in Anki.`);
    } catch (e) {
      this.setStatus(e.message);
    }
    if (current && !decks.includes(current)) decks.unshift(current);
    for (let d of decks) menulist.appendItem(d, d);
    if (current) menulist.value = current;
    else if (decks.length) {
      menulist.selectedIndex = 0;
      this.onDeckChange();
    }
  },

  onDeckChange() {
    let menulist = document.getElementById("z2a-deck");
    if (menulist && menulist.value) {
      Zotero.Prefs.set(this.PREF + "deck", menulist.value, true);
    }
  },
};
