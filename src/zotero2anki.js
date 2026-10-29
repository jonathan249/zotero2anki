/* global Zotero */
/* eslint-disable no-unused-vars */

Zotero2Anki = {
  id: null,
  version: null,
  rootURI: null,
  sectionID: null,
  PREF: "extensions.zotero2anki.",
  HTML_NS: "http://www.w3.org/1999/xhtml",

  drafts: new Map(), // top-level item ID -> draft card
  panels: new Set(), // live sidebar panel bodies
  decks: null, // cached deck names from Anki

  // ================================================================ lifecycle

  init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    Zotero.Zotero2Anki = this; // lets the preference pane reach us

    // "＋ Anki" button in the popup that appears when you select text
    Zotero.Reader.registerEventListener(
      "renderTextSelectionPopup",
      (event) => this.renderSelectionButton(event),
      id
    );

    // "Send to Anki panel" in the right-click menu of existing annotations
    Zotero.Reader.registerEventListener(
      "createAnnotationContextMenu",
      (event) => this.addAnnotationMenuItem(event),
      id
    );

    // Card editor in the reader's right sidebar
    this.sectionID = Zotero.ItemPaneManager.registerSection({
      paneID: "zotero2anki-card",
      pluginID: id,
      header: {
        l10nID: "zotero2anki-section-header",
        icon: rootURI + "icons/card.svg",
      },
      sidenav: {
        l10nID: "zotero2anki-section-sidenav",
        icon: rootURI + "icons/card.svg",
      },
      onInit: ({ body, doc }) => this.buildPanel(body, doc),
      onDestroy: ({ body }) => this.panels.delete(body),
      onItemChange: ({ body, item, tabType, setEnabled }) => {
        setEnabled(tabType === "reader");
        body._z2aKey = item ? item.id : null;
      },
      onRender: ({ body, setSectionSummary }) => {
        this.renderPanel(body);
        let d = this.drafts.get(body._z2aKey);
        setSectionSummary(d && (d.front || d.back) ? "draft" : "");
      },
    });

    // Settings → Zotero2Anki
    Zotero.PreferencePanes.register({
      pluginID: id,
      src: rootURI + "preferences.xhtml",
      scripts: [rootURI + "preferences.js"],
      label: "Zotero2Anki",
    });

    for (let win of Zotero.getMainWindows()) this.addToWindow(win);
    this.log("started v" + version);
  },

  shutdown() {
    for (let win of Zotero.getMainWindows()) this.removeFromWindow(win);
    // Reader listeners, item pane sections and pref panes registered with a
    // pluginID are removed automatically when the plugin shuts down.
    delete Zotero.Zotero2Anki;
  },

  addToWindow(win) {
    let doc = win.document;
    win.MozXULElement.insertFTLIfNeeded("zotero2anki.ftl");
    if (!doc.getElementById("z2a-stylesheet")) {
      let link = doc.createElementNS(this.HTML_NS, "link");
      link.id = "z2a-stylesheet";
      link.rel = "stylesheet";
      link.href = this.rootURI + "style.css";
      doc.documentElement.appendChild(link);
    }
  },

  removeFromWindow(win) {
    let doc = win.document;
    doc.getElementById("z2a-stylesheet")?.remove();
    doc.querySelector('[href="zotero2anki.ftl"]')?.remove();
  },

  // ================================================================ helpers

  log(msg) {
    Zotero.debug("Zotero2Anki: " + msg);
  },

  pref(key) {
    return Zotero.Prefs.get(this.PREF + key, true);
  },

  setPref(key, value) {
    Zotero.Prefs.set(this.PREF + key, value, true);
  },

  notify(message, isError = false) {
    let pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline(isError ? "Zotero2Anki — error" : "Zotero2Anki");
    pw.addDescription(message);
    pw.show();
    pw.startCloseTimer(isError ? 8000 : 3000);
  },

  escapeHTML(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  // Plain text from the editor → Anki field HTML
  toHTML(text) {
    return this.escapeHTML(text.trim()).replace(/\r?\n/g, "<br>");
  },

  // ================================================================ AnkiConnect

  async anki(action, params = {}) {
    let url = this.pref("ankiConnectURL") || "http://127.0.0.1:8765";
    let xhr;
    try {
      xhr = await Zotero.HTTP.request("POST", url, {
        body: JSON.stringify({ action, version: 6, params }),
        headers: { "Content-Type": "application/json" },
        timeout: 10000,
      });
    } catch (e) {
      this.log("AnkiConnect request failed: " + e);
      throw new Error(
        "Couldn't reach Anki at " + url +
        ". Make sure Anki is open and the AnkiConnect add-on is installed."
      );
    }
    let res;
    try {
      res = JSON.parse(xhr.responseText);
    } catch (e) {
      throw new Error("Unexpected response from AnkiConnect: " + xhr.responseText);
    }
    if (res.error) throw new Error(res.error);
    return res.result;
  },

  /**
   * Find the note type and field names to use, based on what actually exists
   * in Anki. Tries the configured name, then a case-insensitive match, then
   * any note type of the right kind (standard vs. cloze) — so it works with
   * non-English Anki or renamed note types. Returns { name, f1, f2 }.
   */
  async resolveModel(cloze) {
    let kind = cloze ? "cloze" : "basic";
    if (this.modelCache?.[kind]) return this.modelCache[kind];

    let prefKey = cloze ? "clozeNoteType" : "basicNoteType";
    let wanted = (this.pref(prefKey) || "").trim();
    let names = await this.anki("modelNames");
    let name =
      names.find((n) => n === wanted) ||
      names.find((n) => n.toLowerCase() === wanted.toLowerCase());

    if (!name) {
      // Look the note types up by kind (type 1 = cloze, 0 = standard).
      let models = [];
      try {
        let ids = await this.anki("modelNamesAndIds");
        models = await this.anki("findModelsById", { modelIds: Object.values(ids) });
      } catch (e) {
        this.log("findModelsById unavailable (old AnkiConnect?): " + e.message);
      }
      if (models.length) {
        let candidates = models.filter((m) => (m.type === 1) === cloze);
        if (!cloze) {
          // Prefer the plain two-field, one-card type (Anki's built-in "Basic").
          candidates.sort((a, b) =>
            (a.flds.length === 2 && a.tmpls.length === 1 ? 0 : 1) -
            (b.flds.length === 2 && b.tmpls.length === 1 ? 0 : 1));
        }
        name = candidates[0]?.name;
      } else {
        name = cloze
          ? names.find((n) => /cloze|lücke|texte à trous|huecos/i.test(n))
          : names.find((n) => !/cloze|lücke|texte à trous|huecos/i.test(n));
      }
    }

    if (!name) {
      throw new Error(
        `No ${kind} note type found in Anki. Available note types: ${names.join(", ")}. ` +
        "Set the right one in Zotero Settings → Zotero2Anki → Note types."
      );
    }

    let fields = await this.anki("modelFieldNames", { modelName: name });
    let f1Pref = this.pref(cloze ? "clozeTextField" : "basicFrontField");
    let f2Pref = this.pref(cloze ? "clozeExtraField" : "basicBackField");
    let pick = (want, fallbackIndex) =>
      fields.find((f) => f === want) ||
      fields.find((f) => f.toLowerCase() === (want || "").toLowerCase()) ||
      fields[fallbackIndex];
    let f1 = pick(f1Pref, 0);
    let f2 = pick(f2Pref, 1);
    if (f2 === f1) f2 = fields.find((f) => f !== f1);
    if (!f1 || (!cloze && !f2)) {
      throw new Error(`Note type “${name}” needs at least ${cloze ? 1 : 2} fields (it has: ${fields.join(", ")}).`);
    }

    // Remember what worked so the settings reflect reality.
    if (name !== wanted) {
      this.log(`using note type “${name}” instead of “${wanted}”`);
      this.setPref(prefKey, name);
    }
    this.setPref(cloze ? "clozeTextField" : "basicFrontField", f1);
    if (f2) this.setPref(cloze ? "clozeExtraField" : "basicBackField", f2);

    this.modelCache = this.modelCache || {};
    this.modelCache[kind] = { name, f1, f2 };
    return this.modelCache[kind];
  },

  async loadDecks() {
    this.modelCache = null; // note types may have changed too
    let decks = await this.anki("deckNames");
    decks.sort((a, b) => a.localeCompare(b));
    this.decks = decks;
    return decks;
  },

  // ================================================================ drafts

  draftKey(attachment) {
    return attachment.parentItemID || attachment.id;
  },

  getDraft(key) {
    if (!this.drafts.has(key)) {
      this.drafts.set(key, {
        cardType: this.pref("cardType") === "cloze" ? "cloze" : "basic",
        front: "", // Basic: question · Cloze: text with {{c1::…}}
        back: "", // Basic: answer · Cloze: back extra
        tags: this.pref("tags") || "",
        includeSource: true,
        source: null, // { attachmentID, pageLabel, pageIndex, annotationKey }
        annotationKeys: [],
      });
    }
    return this.drafts.get(key);
  },

  // Called from the reader: add text to the draft and show the panel.
  sendToPanel({ attachment, text, comment, pageLabel, pageIndex, annotationKey }) {
    text = (text || "").trim();
    if (!text) return;
    let key = this.draftKey(attachment);
    let d = this.getDraft(key);
    let append = (a, b) => (a.trim() ? a.replace(/\s+$/, "") + "\n\n" + b : b);

    if (d.cardType === "basic") {
      d.back = append(d.back, text);
      if (comment && !d.front.trim()) d.front = comment;
    } else {
      d.front = append(d.front, text);
      if (comment && !d.back.trim()) d.back = comment;
    }
    d.source = {
      attachmentID: attachment.id,
      pageLabel,
      pageIndex: Number.isInteger(pageIndex) ? pageIndex : null,
      annotationKey: annotationKey || null,
    };
    if (annotationKey && !d.annotationKeys.includes(annotationKey)) {
      d.annotationKeys.push(annotationKey);
    }

    this.refreshPanels(key);
    this.revealPanel(key);
  },

  refreshPanels(key) {
    for (let body of this.panels) {
      if (body._z2aKey === key) this.renderPanel(body);
    }
  },

  revealPanel(key) {
    let win = Zotero.getMainWindow();
    try {
      if (win.ZoteroContextPane && win.ZoteroContextPane.collapsed) {
        win.ZoteroContextPane.togglePane();
      }
    } catch (e) {
      this.log("could not open context pane: " + e);
    }
    // Let the pane lay out before scrolling to the section.
    win.setTimeout(() => {
      let shown = false;
      for (let body of this.panels) {
        if (body._z2aKey !== key || !body.isConnected) continue;
        try {
          let section = body.closest("collapsible-section");
          if (section) section.open = true;
          body.closest("item-details")?.scrollToPane?.(this.sectionID, "smooth");
        } catch (e) {
          this.log("scrollToPane failed: " + e);
        }
        let rect = body.getBoundingClientRect();
        if (rect.width > 0) {
          shown = true;
          let d = this.getDraft(key);
          let field = d.cardType === "basic" && !d.front.trim() ? body._z2a.front : null;
          field?.focus();
        }
      }
      if (!shown) {
        this.notify("Added to your Anki draft. Open the “Anki card” section in the right sidebar to edit it.");
      }
    }, 50);
  },

  // ================================================================ reader hooks

  renderSelectionButton({ reader, doc, params, append }) {
    let annotation = params.annotation;
    if (!annotation || !annotation.text) return;

    let button = doc.createElement("button");
    button.textContent = "＋ Anki";
    button.title = "Send this selection to the Anki card editor in the sidebar";
    button.style.cssText =
      "margin: 4px; padding: 3px 10px; border-radius: 5px; cursor: pointer;" +
      "border: 1px solid rgba(0,0,0,0.2); font: inherit; font-size: 12px;";

    // Capture now: the popup and selection may go away on click.
    let data = {
      attachment: Zotero.Items.get(reader.itemID),
      text: annotation.text,
      comment: "",
      pageLabel: annotation.pageLabel,
      pageIndex: annotation.position ? annotation.position.pageIndex : null,
      annotationKey: null,
    };

    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        this.sendToPanel(data);
      } catch (err) {
        this.notify(err.message, true);
      }
    });

    append(button);
  },

  addAnnotationMenuItem({ reader, params, append }) {
    let attachment = Zotero.Items.get(reader.itemID);
    append({
      label: params.ids.length > 1
        ? `Send ${params.ids.length} annotations to Anki panel`
        : "Send to Anki panel",
      onCommand: () => {
        for (let key of params.ids) {
          let annot = Zotero.Items.getByLibraryAndKey(attachment.libraryID, key);
          if (!annot || !annot.annotationText) continue; // images/ink have no text
          let pos = {};
          try { pos = JSON.parse(annot.annotationPosition); } catch (e) {}
          this.sendToPanel({
            attachment,
            text: annot.annotationText,
            comment: annot.annotationComment || "",
            pageLabel: annot.annotationPageLabel,
            pageIndex: pos.pageIndex,
            annotationKey: annot.key,
          });
        }
      },
    });
  },

  // ================================================================ sidebar panel

  buildPanel(body, doc) {
    let h = (tag, attrs = {}, children = []) => {
      let el = doc.createElementNS(this.HTML_NS, tag);
      for (let [k, v] of Object.entries(attrs)) {
        if (k === "text") el.textContent = v;
        else el.setAttribute(k, v);
      }
      for (let c of children) el.append(c);
      return el;
    };

    let ui = {};
    ui.deck = h("select", { class: "z2a-deck", title: "Deck" });
    ui.refresh = h("button", { class: "z2a-icon-btn", title: "Reload decks from Anki", text: "↻" });
    ui.type = h("select", { class: "z2a-type", title: "Card type" }, [
      h("option", { value: "basic", text: "Basic" }),
      h("option", { value: "cloze", text: "Cloze" }),
    ]);
    ui.frontLabel = h("label", { class: "z2a-label" });
    ui.clozeBtn = h("button", {
      class: "z2a-small-btn",
      title: "Wrap the selected words in a cloze deletion (Ctrl/Cmd+Shift+C)",
      text: "[…] Cloze selection",
    });
    ui.front = h("textarea", { class: "z2a-field", rows: "4" });
    ui.backLabel = h("label", { class: "z2a-label" });
    ui.back = h("textarea", { class: "z2a-field", rows: "5" });
    ui.includeSource = h("input", { type: "checkbox", class: "z2a-check" });
    ui.sourceText = h("span", { class: "z2a-source" });
    ui.tags = h("input", { type: "text", class: "z2a-tags", placeholder: "tags, space-separated" });
    ui.add = h("button", { class: "z2a-primary", text: "Add card" });
    ui.clear = h("button", { class: "z2a-small-btn", text: "Clear" });
    ui.status = h("div", { class: "z2a-status" });

    let root = h("div", { class: "z2a-panel" }, [
      h("div", { class: "z2a-row" }, [ui.deck, ui.refresh, ui.type]),
      h("div", { class: "z2a-row z2a-between" }, [ui.frontLabel, ui.clozeBtn]),
      ui.front,
      ui.backLabel,
      ui.back,
      h("label", { class: "z2a-row z2a-source-row" }, [ui.includeSource, ui.sourceText]),
      ui.tags,
      h("div", { class: "z2a-row z2a-between" }, [ui.clear, ui.add]),
      ui.status,
    ]);
    body.replaceChildren(root);
    body._z2a = ui;
    this.panels.add(body);

    let draft = () => this.getDraft(body._z2aKey);

    ui.front.addEventListener("input", () => { draft().front = ui.front.value; });
    ui.back.addEventListener("input", () => { draft().back = ui.back.value; });
    ui.tags.addEventListener("input", () => { draft().tags = ui.tags.value; });
    ui.includeSource.addEventListener("change", () => {
      draft().includeSource = ui.includeSource.checked;
    });
    ui.type.addEventListener("change", () => {
      draft().cardType = ui.type.value;
      this.renderPanel(body);
    });
    ui.deck.addEventListener("change", () => {
      if (ui.deck.value) this.setPref("deck", ui.deck.value);
      this.refreshAllDeckMenus();
    });
    ui.refresh.addEventListener("click", () => this.populateDecks(body, true));
    ui.clozeBtn.addEventListener("click", () => this.wrapCloze(body));
    ui.clear.addEventListener("click", () => {
      this.resetDraft(draft());
      this.renderPanel(body);
    });
    ui.add.addEventListener("click", () => this.addCard(body));

    root.addEventListener("keydown", (e) => {
      let mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        this.addCard(body);
      } else if (mod && e.shiftKey && (e.key === "C" || e.key === "c") && e.target === ui.front) {
        e.preventDefault();
        this.wrapCloze(body);
      }
    });

    this.populateDecks(body, false);
  },

  renderPanel(body) {
    let ui = body._z2a;
    if (!ui || body._z2aKey == null) return;
    let d = this.getDraft(body._z2aKey);
    let cloze = d.cardType === "cloze";

    ui.type.value = d.cardType;
    ui.frontLabel.textContent = cloze ? "Text" : "Front";
    ui.backLabel.textContent = cloze ? "Back extra" : "Back";
    ui.front.placeholder = cloze
      ? "Select text in the PDF and click ＋ Anki, then mark words to hide"
      : "Type your question…";
    ui.back.placeholder = cloze ? "Optional extra info" : "Select text in the PDF and click ＋ Anki";
    ui.clozeBtn.hidden = !cloze;
    if (ui.front.value !== d.front) ui.front.value = d.front;
    if (ui.back.value !== d.back) ui.back.value = d.back;
    if (ui.tags.value !== d.tags) ui.tags.value = d.tags;
    ui.includeSource.checked = d.includeSource;
    ui.sourceText.textContent = d.source
      ? "Add source & link: " + this.formatSourceText(d.source)
      : "Add source & link (once you send text from the PDF)";
  },

  async populateDecks(body, force) {
    let ui = body._z2a;
    try {
      if (force || !this.decks) await this.loadDecks();
      if (force) ui.status.textContent = `Loaded ${this.decks.length} decks.`;
    } catch (e) {
      ui.status.textContent = e.message;
    }
    this.fillDeckMenu(ui.deck);
    if (force) this.refreshAllDeckMenus();
  },

  fillDeckMenu(select) {
    let current = this.pref("deck") || "";
    let decks = (this.decks || []).slice();
    if (current && !decks.includes(current)) decks.unshift(current);
    let doc = select.ownerDocument;
    select.replaceChildren(
      ...decks.map((d) => {
        let opt = doc.createElementNS(this.HTML_NS, "option");
        opt.value = d;
        opt.textContent = d;
        return opt;
      })
    );
    select.value = current;
  },

  refreshAllDeckMenus() {
    for (let body of this.panels) {
      if (body._z2a) this.fillDeckMenu(body._z2a.deck);
    }
  },

  wrapCloze(body) {
    let ui = body._z2a;
    let ta = ui.front;
    let { selectionStart: s, selectionEnd: e, value } = ta;
    if (s === e) {
      ui.status.textContent = "Select the words to hide in the Text box first.";
      return;
    }
    let nums = [...value.matchAll(/\{\{c(\d+)::/g)].map((m) => +m[1]);
    let n = nums.length ? Math.max(...nums) + 1 : 1;
    let wrapped = `{{c${n}::${value.slice(s, e)}}}`;
    ta.value = value.slice(0, s) + wrapped + value.slice(e);
    ta.setSelectionRange(s + wrapped.length, s + wrapped.length);
    ta.focus();
    this.getDraft(body._z2aKey).front = ta.value;
    ui.status.textContent = "";
  },

  resetDraft(d) {
    d.front = "";
    d.back = "";
    d.source = null;
    d.annotationKeys = [];
  },

  // ================================================================ card creation

  zoteroLink(attachment, pageIndex, annotationKey) {
    let lib = Zotero.Libraries.get(attachment.libraryID);
    let libPath = lib.libraryType === "group" ? `groups/${lib.groupID}` : "library";
    let url = `zotero://open-pdf/${libPath}/items/${attachment.key}`;
    let qs = [];
    if (Number.isInteger(pageIndex)) qs.push("page=" + (pageIndex + 1));
    if (annotationKey) qs.push("annotation=" + annotationKey);
    return qs.length ? url + "?" + qs.join("&") : url;
  },

  sourceParts(source) {
    let attachment = Zotero.Items.get(source.attachmentID);
    let item = attachment.parentItem || attachment;
    let creator = item.getField("firstCreator") || "";
    let year = "";
    try {
      year = Zotero.Date.strToDate(item.getField("date")).year || "";
    } catch (e) {}
    let title = item.getField("title") || attachment.getField("title") || "Untitled";
    let byline = [creator, year ? `(${year})` : ""].filter(Boolean).join(" ");
    return { attachment, byline, title, page: source.pageLabel };
  },

  formatSourceText(source) {
    let p = this.sourceParts(source);
    return [p.byline, p.title, p.page ? "p. " + p.page : ""].filter(Boolean).join(", ");
  },

  formatSourceHTML(source) {
    let p = this.sourceParts(source);
    let parts = [];
    if (p.byline) parts.push(this.escapeHTML(p.byline));
    parts.push(`<i>${this.escapeHTML(p.title)}</i>`);
    if (p.page) parts.push("p. " + this.escapeHTML(p.page));
    let link = this.zoteroLink(p.attachment, source.pageIndex, source.annotationKey);
    return (
      `<div class="z2a-source" style="margin-top:1em;font-size:0.85em;opacity:0.75">` +
      `${parts.join(", ")} · <a href="${link}">Open in Zotero</a></div>`
    );
  },

  async addCard(body) {
    let ui = body._z2a;
    let key = body._z2aKey;
    let d = this.getDraft(key);
    let deck = ui.deck.value || this.pref("deck");
    let cloze = d.cardType === "cloze";

    // Validate
    if (!deck) return (ui.status.textContent = "Choose a deck first.");
    if (!d.front.trim()) {
      ui.status.textContent = cloze ? "The Text field is empty." : "Write a question on the front.";
      return ui.front.focus();
    }
    if (cloze && !/\{\{c\d+::/.test(d.front)) {
      ui.status.textContent = "Mark at least one {{c1::…}} deletion (select words, then “Cloze selection”).";
      return ui.front.focus();
    }
    if (!cloze && !d.back.trim()) {
      ui.status.textContent = "The back is empty.";
      return ui.back.focus();
    }

    let sourceHTML = "";
    if (d.includeSource && d.source) {
      try {
        sourceHTML = this.formatSourceHTML(d.source);
      } catch (e) {
        this.log("source formatting failed: " + e);
      }
    }

    ui.add.disabled = true;
    ui.status.textContent = "Adding…";
    let model;
    try {
      model = await this.resolveModel(cloze);
      let fields = { [model.f1]: this.toHTML(d.front) };
      let backHTML = (d.back.trim() ? this.toHTML(d.back) : "") + sourceHTML;
      if (model.f2) fields[model.f2] = backHTML;
      else if (sourceHTML) fields[model.f1] += sourceHTML; // single-field cloze type

      await this.anki("addNote", {
        note: {
          deckName: deck,
          modelName: model.name,
          fields,
          tags: d.tags.split(/\s+/).filter(Boolean),
          options: { allowDuplicate: !!this.pref("allowDuplicates") },
        },
      });
    } catch (e) {
      if (/model was not found|field/i.test(e.message)) this.modelCache = null;
      ui.status.textContent = e.message;
      ui.add.disabled = false;
      return;
    }

    // Tag the source annotations so you can see what's been carded
    if (this.pref("tagAnnotation") && d.annotationKeys.length && d.source) {
      let attachment = Zotero.Items.get(d.source.attachmentID);
      for (let k of d.annotationKeys) {
        let annot = Zotero.Items.getByLibraryAndKey(attachment.libraryID, k);
        if (annot) {
          annot.addTag("anki");
          await annot.saveTx();
        }
      }
    }

    this.resetDraft(d);
    this.refreshPanels(key);
    ui.add.disabled = false;
    ui.status.textContent = `✓ Added to “${deck}” (note type “${model.name}”).`;
  },
};
