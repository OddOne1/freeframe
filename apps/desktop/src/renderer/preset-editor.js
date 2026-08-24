// Naming-preset editor (§10 / §18b), extracted from index.html by §61.
//
// It moved out of the main window into the Settings window's own tab. It is
// a separate FILE rather than a copy of the code, for the reason this
// project keeps rediscovering: two copies of one rule drift (§30's
// _require_download_variant, §32's resolveStreamUrl). The main window no
// longer renders any of this — it keeps only the active-preset selector and
// the per-transfer Fields panel.
//
// The host supplies the small amount of context it cannot know: which DOM
// nodes to draw into, and a sample source path for the live preview (the
// Settings window has no assigned source, so it uses a stand-in).

window.PresetEditor = (function () {
  "use strict";

  function el(tag, opts = {}, children = []) {
    const n = document.createElement(tag);
    if (opts.class) n.className = opts.class;
    if (opts.text != null) n.textContent = opts.text;
    if (opts.title) n.title = opts.title;
    if (opts.id) n.id = opts.id;
    if (opts.dataset) for (const [k, v] of Object.entries(opts.dataset)) n.dataset[k] = v;
    if (opts.style) n.setAttribute("style", opts.style);
    if (opts.onClick) n.addEventListener("click", opts.onClick);
    if (opts.disabled) n.disabled = true;
    for (const c of children) if (c) n.appendChild(c);
    return n;
  }
  function icon(name) {
    const span = document.createElement("span");
    span.className = "icon";
    span.innerHTML = (window.FF_ICONS && window.FF_ICONS[name]) || "";
    return span;
  }
  const $ = (id) => document.getElementById(id);

  /**
   * §61 — the editor used to be one continuous vertical list: name field,
   * a bare "Fields" text label, rows, two pattern inputs with hints and
   * chips, a preview, a counter, then the one already-grouped piece (the
   * filtering <details>) and a Delete button. Nothing said where one
   * concern ended and the next began.
   *
   * Everything is a titled card now, with the filtering block's existing
   * treatment extended to the rest rather than a new pattern invented for
   * it. FIRST DESIGN PASS — the grouping is a judgement call and wants a
   * look before it is called finished.
   */
  function section(title, sub) {
    const box = el("section", { class: "pe-section" });
    box.appendChild(el("h4", { class: "pe-section-title", text: title }));
    if (sub) box.appendChild(el("div", { class: "token-help pe-section-sub", text: sub }));
    return box;
  }

  // State the editor owns. `presetStore` is re-read from main after every
  // mutation rather than patched locally, so the window can never disagree
  // with the file on disk.
  let presetStore = { presets: [], history: {}, sourceCounter: 1 };
  let nextSourceCounter = 1;
  let editingPreset = null;
  let sampleSource = "/Volumes/A001";

  /**
   * Which built-in tokens each template may use (§22c/§22h).
   *
   * Split because the two answer different questions. `{counter}` numbers
   * files WITHIN one source, so putting it in a folder pattern creates a
   * separate folder per file — the exact bug this fixes, previously
   * unavoidable because every chip wrote into the folder field regardless
   * of where the cursor was. `{sourcecounter}` numbers the sources
   * themselves, which is only meaningful for a folder.
   *
   * Typing a token by hand is still allowed either way; naming.js resolves
   * whatever it is given. This governs which one-click chips are offered,
   * so the footgun isn't handed over by default.
   */
  const TOKENS_ANYWHERE = [
    "date", "yyyy", "yy", "mm", "dd", "time", "datetime", "cardname",
  ];
  const TOKENS_FOLDER_ONLY = ["sourcecounter"];
  const TOKENS_FILE_ONLY = ["counter", "name", "ext"];

  function tokensFor(key) {
    return key === "fileTemplate"
      ? [...TOKENS_ANYWHERE, ...TOKENS_FILE_ONLY]
      : [...TOKENS_ANYWHERE, ...TOKENS_FOLDER_ONLY];
  }

  /**
   * Insert text at the caret of an input, leaving the caret after it.
   *
   * Appending to the end (what this used to do) loses the user's place in
   * a pattern they are part-way through typing, and the full re-render
   * that followed threw away focus as well.
   */
  function insertAtCaret(input, text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const caret = start + text.length;
    input.focus();
    input.setSelectionRange(caret, caret);
  }

  function renderPresetList() {
    const host = $("preset-list");
    if (!host) return;
    host.replaceChildren();
    if (presetStore.presets.length === 0) {
      host.appendChild(el("div", { class: "token-help", style: "padding:6px", text: "No presets yet." }));
    }
    for (const p of presetStore.presets) {
      const b = el("button", {
        text: p.name,
        class: editingPreset && editingPreset.id === p.id ? "active" : "",
        onClick: () => { editingPreset = JSON.parse(JSON.stringify(p)); renderPresetList(); renderPresetPane(); },
      });
      host.appendChild(b);
    }
  }

  function newPresetDraft() {
    return {
      id: null,
      name: "",
      folderTemplate: "{date}_{cardname}",
      fileTemplate: "",
      fields: [],
    };
  }

  /** Live preview, rendered by main using the same code the copy runs —
   *  a preview computed by a lookalike would build confidence in the
   *  wrong thing. */
  async function refreshPresetPreview() {
    const out = $("tpl-preview");
    if (!out || !editingPreset) return;
    const sample = {};
    for (const f of editingPreset.fields) sample[f.key] = f.label || f.key;
    const res = await window.freeframe.previewNaming(
      editingPreset.folderTemplate, editingPreset.fileTemplate, sample,
      sampleSource,
    );
    out.classList.toggle("bad", !res.ok);
    out.textContent = res.ok
      ? `${res.sample}  →  ${res.result}`
      : res.error;
  }
  function renderPresetPane() {
    const host = $("preset-pane");
    if (!host) return;
    host.replaceChildren();
    if (!editingPreset) {
      host.appendChild(el("div", { class: "token-help", text: "Pick a preset on the left, or create a new one." }));
      return;
    }

    const nameBox = section("Preset name");
    const nameWrap = el("div", { class: "field" });
    nameWrap.appendChild(el("label", { text: "Preset name" }));
    const nameInput = el("input", { dataset: { role: "preset-name" } });
    nameInput.type = "text";
    nameInput.value = editingPreset.name;
    nameInput.addEventListener("input", () => { editingPreset.name = nameInput.value; });
    nameWrap.appendChild(nameInput);
    nameBox.appendChild(nameWrap);
    host.appendChild(nameBox);

    // ── Fields ──
    const fieldsBox = section("Fields",
      "Values you fill in per transfer. Each one becomes a token you can put in a name below.");

    editingPreset.fields.forEach((f, i) => {
      const row = el("div", { class: "field-row" });

      // Sizing lives in .field-row's CSS now, so the row can wrap rather
      // than the input collapsing to nothing (§22d).
      const label = el("input");
      label.type = "text";
      label.placeholder = "Field name (e.g. Operator)";
      label.value = f.label;
      label.addEventListener("input", () => {
        f.label = label.value;
        // The token follows the label until the user has typed one, so
        // {operator} appears as they name the field.
        f.key = label.value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
        tok.textContent = f.key ? `{${f.key}}` : "";
      });
      row.appendChild(label);

      const tok = el("span", { class: "tok", text: f.key ? `{${f.key}}` : "" });
      row.appendChild(tok);

      // Everything after the name travels together, so it wraps to a
      // second line as a block rather than one control at a time.
      const controls = el("div", { class: "field-row-controls" });

      const type = el("select");
      for (const [v, t] of [["text", "Text"], ["select", "Suggesting"]]) {
        const o = el("option", { text: t });
        o.value = v;
        if (f.type === v) o.selected = true;
        type.appendChild(o);
      }
      type.title = "Suggesting fields offer what you've typed before";
      type.addEventListener("change", () => { f.type = type.value; });
      controls.appendChild(type);

      const reqWrap = el("label", { class: "req" });
      const req = el("input");
      req.type = "checkbox";
      req.checked = Boolean(f.required);
      req.addEventListener("change", () => { f.required = req.checked; });
      reqWrap.appendChild(req);
      reqWrap.appendChild(el("span", { text: "Required" }));
      controls.appendChild(reqWrap);

      const up = el("button", { class: "icon-btn", title: "Move up", disabled: i === 0,
        onClick: () => {
          const [m] = editingPreset.fields.splice(i, 1);
          editingPreset.fields.splice(i - 1, 0, m);
          renderPresetPane();
        } });
      up.textContent = "↑";
      controls.appendChild(up);

      const down = el("button", { class: "icon-btn", title: "Move down", disabled: i === editingPreset.fields.length - 1,
        onClick: () => {
          const [m] = editingPreset.fields.splice(i, 1);
          editingPreset.fields.splice(i + 1, 0, m);
          renderPresetPane();
        } });
      down.textContent = "↓";
      controls.appendChild(down);

      const del = el("button", { class: "icon-btn", title: "Remove field",
        onClick: () => { editingPreset.fields.splice(i, 1); renderPresetPane(); refreshPresetPreview(); } });
      del.appendChild(icon("close"));
      controls.appendChild(del);

      row.appendChild(controls);
      fieldsBox.appendChild(row);
    });

    const addField = el("button", {
      text: "Add field",
      onClick: () => {
        editingPreset.fields.push({ key: "", label: "", type: "text", required: false });
        renderPresetPane();
      },
    });
    fieldsBox.appendChild(addField);
    if (!editingPreset.fields.length) {
      fieldsBox.insertBefore(
        el("div", { class: "token-help", text: "No fields yet." }),
        addField,
      );
    }
    host.appendChild(fieldsBox);

    // ── Patterns ──
    const patternBox = section("Naming pattern",
      "Built from the fields above plus the built-in tokens. The preview at the bottom is rendered by the same code the copy runs.");
    for (const [key, title, placeholder, hint] of [
      ["folderTemplate", "Destination folder", "{date}_{cardname}", "Subfolder created under each destination. Use / for nesting."],
      ["fileTemplate", "File name (optional)", "leave empty to keep original names", "The extension is always kept from the source."],
    ]) {
      patternBox.appendChild(el("label", { class: "pe-label", text: title }));
      const input = el("input", { class: "tpl-input", dataset: { tpl: key } });
      input.type = "text";
      input.placeholder = placeholder;
      input.value = editingPreset[key] || "";
      input.addEventListener("input", () => { editingPreset[key] = input.value; refreshPresetPreview(); });
      patternBox.appendChild(input);
      patternBox.appendChild(el("div", { class: "token-help", text: hint }));

      // One chip row per field, holding only the tokens valid there.
      // Previously a single shared row wrote every token into
      // folderTemplate no matter which input had focus — so clicking
      // {counter} while editing the file name silently created a
      // uniquely-numbered FOLDER for every file (§22c).
      const chips = el("div", { class: "token-help" });
      chips.appendChild(document.createTextNode("Click to insert: "));
      const fieldTokens = editingPreset.fields.map((f) => f.key).filter(Boolean);
      for (const t of [...fieldTokens, ...tokensFor(key)]) {
        const code = el("code", { text: `{${t}}` });
        // mousedown, not click: the default mousedown would blur the
        // input first and take the caret position with it.
        code.addEventListener("mousedown", (e) => {
          e.preventDefault();
          insertAtCaret(input, `{${t}}`);
          editingPreset[key] = input.value;
          refreshPresetPreview();
        });
        chips.appendChild(code);
        chips.appendChild(document.createTextNode(" "));
      }
      patternBox.appendChild(chips);
    }

    patternBox.appendChild(el("div", { id: "tpl-preview", class: "tpl-preview" }));
    host.appendChild(patternBox);

    // §22h — the source counter is shared across presets, not part of the
    // one being edited, so it sits apart from the pattern fields. Shown
    // here anyway because this is the only window where {sourcecounter}
    // is visible at all, and a number that advances by itself needs to be
    // correctable when a shoot restarts.
    const counterBox = section("Card numbering",
      "Shared by every preset — this number is not part of the one being edited.");
    const counterRow = el("div", { class: "filter-row" });
    counterRow.appendChild(el("label", { text: "Next card #" }));
    const counterInput = el("input", { id: "source-counter" });
    counterInput.type = "number";
    counterInput.min = "1";
    counterInput.value = String(nextSourceCounter);
    counterInput.addEventListener("change", async () => {
      nextSourceCounter = await window.freeframe.setSourceCounter(counterInput.value);
      counterInput.value = String(nextSourceCounter);
      // Numbers already handed to assigned sources stay as they were —
      // this sets what the NEXT card gets, not a retroactive renumber.
    });
    counterRow.appendChild(counterInput);
    counterBox.appendChild(counterRow);
    counterBox.appendChild(el("div", {
      class: "token-help",
      text: "What {sourcecounter} renders as for the next source you add. Advances on its own each time a card is assigned.",
    }));
    host.appendChild(counterBox);

    const filterBox = section("Filtering");
    filterBox.appendChild(renderFilterBlock());
    host.appendChild(filterBox);

    if (editingPreset.id) {
      const del = el("button", {
        style: "margin-top:10px",
        text: "Delete preset",
        onClick: async () => {
          // The main window clears its own active-preset selection when the
          // presets:changed broadcast arrives — it owns that state, this
          // window does not, and reaching across would be the drift this
          // extraction exists to avoid.
          await window.freeframe.deletePreset(editingPreset.id);
          editingPreset = null;
          await reloadPresets();
        },
      });
      host.appendChild(del);
    }

    refreshPresetPreview();
  }

  function renderFilterBlock() {
    const f = editingPreset.filters || {};
    const active =
      (f.doNotCopyExtensions || []).length ||
      (f.doNotCopyNames || []).length ||
      (f.ignoreBundles?.extensions || []).length ||
      (f.ignoreFolders?.mode && f.ignoreFolders.mode !== "off");

    const block = el("details", { class: "filter-block" });
    if (active) block.open = true;
    block.appendChild(el("summary", {
      text: active ? "File filtering — ON" : "File filtering (optional)",
      class: active ? "warn" : "",
    }));
    block.appendChild(el("div", {
      class: "token-help",
      text: "Off by default: everything on the card is copied. Anything you skip here is "
          + "listed in the job's summary and log, never dropped silently.",
    }));

    // Writes into the draft and re-renders the summary line only — a full
    // re-render would collapse the section the user is typing in.
    function set(mutate) {
      editingPreset.filters = editingPreset.filters || {};
      mutate(editingPreset.filters);
    }

    function textRow(label, placeholder, get, put) {
      const row = el("div", { class: "filter-row" });
      row.appendChild(el("label", { text: label }));
      const input = el("input");
      input.type = "text";
      input.placeholder = placeholder;
      input.value = (get() || []).join(", ");
      input.addEventListener("input", () => {
        const parts = input.value.split(",").map((s) => s.trim()).filter(Boolean);
        set((x) => put(x, parts));
      });
      row.appendChild(input);
      return row;
    }

    block.appendChild(textRow(
      "Skip types", ".thm, .ppn, .bmp",
      () => f.doNotCopyExtensions,
      (x, v) => { x.doNotCopyExtensions = v; },
    ));
    block.appendChild(textRow(
      "Skip names", "index.mif, lastclip.txt",
      () => f.doNotCopyNames,
      (x, v) => { x.doNotCopyNames = v; },
    ));
    block.appendChild(textRow(
      "Ignore bundles", ".rdc, .avchd",
      () => f.ignoreBundles?.extensions,
      (x, v) => {
        x.ignoreBundles = { ...(x.ignoreBundles || {}), extensions: v };
      },
    ));

    const sizeRow = el("div", { class: "filter-row" });
    sizeRow.appendChild(el("label", { text: "…under (MB)" }));
    const sizeInput = el("input");
    sizeInput.type = "number";
    sizeInput.min = "0";
    sizeInput.placeholder = "blank = any size";
    sizeInput.value = Number.isFinite(f.ignoreBundles?.maxBytes)
      ? String(Math.round(f.ignoreBundles.maxBytes / (1024 * 1024)))
      : "";
    sizeInput.addEventListener("input", () => {
      const mb = Number(sizeInput.value);
      set((x) => {
        x.ignoreBundles = {
          ...(x.ignoreBundles || {}),
          maxBytes: sizeInput.value.trim() && Number.isFinite(mb) ? mb * 1024 * 1024 : null,
        };
      });
    });
    sizeRow.appendChild(sizeInput);
    block.appendChild(sizeRow);
    block.appendChild(el("div", {
      class: "token-help",
      text: "A size limit is what makes ignoring bundles safe — it targets the empty shells, "
          + "and a bundle holding real footage is over any sane limit. Leave it blank and every "
          + "matching bundle is dropped regardless of what's inside.",
    }));

    const folderRow = el("div", { class: "filter-row" });
    folderRow.appendChild(el("label", { text: "Folders" }));
    const select = el("select");
    for (const [value, label] of [
      ["off", "Keep the source's folder structure"],
      ["whenEmpty", "Skip folders left empty by filtering"],
      ["flatten", "Flatten — copy every file into one folder"],
    ]) {
      const opt = el("option", { text: label });
      opt.value = value;
      if ((f.ignoreFolders?.mode || "off") === value) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => set((x) => { x.ignoreFolders = { mode: select.value }; }));
    folderRow.appendChild(select);
    block.appendChild(folderRow);
    block.appendChild(el("div", {
      class: "token-help",
      text: "Flattening discards the card's own DCIM/CLIP folders. Two files with the same name "
          + "in different folders would collide, and the job is refused rather than one of them "
          + "being overwritten.",
    }));

    return block;
  }


  async function reloadPresets() {
    presetStore = (await window.freeframe.listPresets())
      || { presets: [], history: {}, sourceCounter: 1 };
    nextSourceCounter = presetStore.sourceCounter || 1;
    if (editingPreset && editingPreset.id
        && !presetStore.presets.some((p) => p.id === editingPreset.id)) {
      editingPreset = null;
    }
    renderPresetList();
    renderPresetPane();
  }

  async function save() {
    if (!editingPreset) return { ok: false, error: "Nothing to save" };
    if (!editingPreset.name.trim()) return { ok: false, error: "Give the preset a name" };
    // savePreset returns the whole STORE, not the saved preset — the name
    // is how the caller finds what it just wrote, and main falls back to
    // "Untitled preset" for a blank one.
    const wanted = editingPreset.name.trim() || "Untitled preset";
    presetStore = await window.freeframe.savePreset(editingPreset);
    const saved = (presetStore.presets || []).find((p) => p.name === wanted);
    editingPreset = saved ? JSON.parse(JSON.stringify(saved)) : editingPreset;
    await reloadPresets();
    return { ok: true };
  }

  function startNew() {
    editingPreset = newPresetDraft();
    renderPresetList();
    renderPresetPane();
  }

  return {
    init({ sampleSourcePath } = {}) {
      if (sampleSourcePath) sampleSource = sampleSourcePath;
      return reloadPresets();
    },
    reload: reloadPresets,
    save,
    startNew,
    hasDraft: () => Boolean(editingPreset),
  };
})();
