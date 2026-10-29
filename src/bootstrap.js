/* global Zotero, Services, Zotero2Anki */
var Zotero2Anki;

function install() {}

async function startup({ id, version, rootURI }) {
  Services.scriptloader.loadSubScript(rootURI + "zotero2anki.js");
  Zotero2Anki.init({ id, version, rootURI });
}

function onMainWindowLoad({ window }) {
  Zotero2Anki?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  Zotero2Anki?.removeFromWindow(window);
}

function shutdown() {
  if (Zotero2Anki) Zotero2Anki.shutdown();
  Zotero2Anki = undefined;
}

function uninstall() {}
