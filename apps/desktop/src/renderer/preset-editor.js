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
  // Fired whenever which preset is open changes, so the host can show or
  // hide a Delete that only applies to a SAVED one.
  let onSelectionChange = () => {};

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
  // §65.6 — the chip list is pruned, NOT the token set. {date}, {time},
  // {datetime}, {cardname} and {ext} still resolve in naming.js, so a saved
  // pattern using one keeps working; they are simply no longer offered.
  // {ext} because the extension always comes from the source anyway,
  // {cardname} for want of a filename use case, and {date}/{datetime}
  // because the component tokens below cover them.
  //
  // §65.7 — uppercase is the date half, lowercase the time half. {MM} is
  // month and {mm} is minutes: the same letters, different case, different
  // value. That is deliberate and was accepted knowingly, on the grounds
  // that patterns here are built by clicking chips rather than typing.
  const TOKENS_ANYWHERE = ["YYYY", "YY", "MM", "DD", "hh", "mm"];
  const TOKENS_FOLDER_ONLY = ["sourcecounter"];
  const TOKENS_FILE_ONLY = ["counter", "name"];

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
  /**
   * §65.8 — one preview per pattern field, each showing only its own output.
   *
   * The single full-path preview it replaces read as
   * `DCIM/100MEDIA/CLIP0001.MOV → 20260825/DCIM/100MEDIA/CLIP0001.MOV`,
   * and the `DCIM/100MEDIA/` in the middle is the source's own subtree —
   * preserved by design, produced by neither template. Showing it invited
   * the reading that the pattern had made it.
   */
  async function refreshPresetPreview() {
    const folderOut = $("tpl-preview-folder");
    const fileOut = $("tpl-preview-file");
    if ((!folderOut && !fileOut) || !editingPreset) return;
    const sample = {};
    for (const f of editingPreset.fields) {
      // A Choice field previews as its first option's rendered token, since
      // that is what a real job would actually substitute. Falling back to
      // the field label would preview something the dropdown cannot produce.
      if (f.type === "choice" && Array.isArray(f.options) && f.options.length) {
        const o = f.options[0];
        sample[f.key] = o.token || o.label;
      } else {
        sample[f.key] = f.label || f.key;
      }
    }
    const res = await window.freeframe.previewNaming(
      editingPreset.folderTemplate, editingPreset.fileTemplate, sample,
      sampleSource,
      undefined,
      // §77 — preview the rule being edited, not the default.
      { autoSuffix: editingPreset.autoSuffix || null },
    );
    // Asked as the pattern is typed, not only at save: a refusal that
    // arrives when you press Save is a refusal about something you wrote
    // several edits ago.
    const { error: folderError } = await window.freeframe
      .validateFolderPattern(editingPreset.folderTemplate)
      .catch(() => ({ error: null }));

    // Looked up after BOTH awaits: the pane may have re-rendered during
    // either one, and writing into a detached node fails silently.
    const fo = $("tpl-preview-folder");
    const fi = $("tpl-preview-file");

    if (fo) {
      fo.classList.toggle("bad", !res.ok || Boolean(folderError));
      fo.replaceChildren();
      if (folderError) fo.textContent = folderError;
      else if (!res.ok) fo.textContent = res.error;
      else if (!editingPreset.folderTemplate) {
        fo.textContent = "Files land directly in the destination.";
      } else fo.textContent = `${res.folder}/`;
    }

    if (fi) {
      fi.classList.toggle("bad", !res.ok);
      fi.replaceChildren();
      if (!res.ok) { fi.textContent = res.error; return; }
      if (!editingPreset.fileTemplate) {
        fi.textContent = "Original file names are kept.";
        return;
      }
      // §65.9 — the auto-appended suffix is text the user did not write,
      // so it is marked rather than blended in. Amber is this app's own
      // warning colour (--status-warning), used here as the standing
      // treatment for anything inferred or auto-corrected in a preview.
      //
      // §77 — main reports what it added and where. This used to hunt for
      // four digits at the end with a regex, which stops matching as soon
      // as the suffix is a filename or sits at the front: the marking would
      // vanish and auto-inserted text would read as the user's own.
      const marked = markAutoSuffix(res);
      if (marked) fi.replaceChildren(...marked);
      else fi.textContent = res.file;
    }
  }
  /**
   * §77 — what the safety net appends when the file pattern numbers
   * nothing, and which end it goes on.
   *
   * Two closed choices rather than free text: the engine understands
   * exactly these values, and a typo in a text field would silently fall
   * back to the default while looking configured.
   *
   * `counter` guarantees uniqueness by construction. `filename` is what
   * OffShoot writes — it keeps the camera's own clip name recoverable from
   * the new one, at the cost of inheriting uniqueness from the source tree
   * rather than guaranteeing it. Both defaults match the pre-§77 behaviour,
   * so opening and saving an old preset changes nothing.
   */
  function renderAutoSuffix() {
    const box = el("div", { class: "pe-autosuffix" });
    box.appendChild(el("div", { class: "token-help",
      text: "When the pattern numbers nothing, add:" }));

    const current = () => {
      const a = editingPreset.autoSuffix || {};
      return {
        source: a.source === "filename" ? "filename" : "counter",
        position: a.position === "front" ? "front" : "end",
      };
    };
    const set = (patch) => {
      editingPreset.autoSuffix = { ...current(), ...patch };
      renderPresetPane();
      refreshPresetPreview();
    };

    // Segmented, matching how the rest of this window offers a small closed
    // set rather than introducing a third control style for two options.
    const group = (axis, options) => {
      const row = el("div", { class: "pe-seg" });
      for (const [value, label, title] of options) {
        const b = el("button", {
          class: current()[axis] === value ? "on" : "",
          text: label, title,
          onClick: () => set({ [axis]: value }),
        });
        row.appendChild(b);
      }
      return row;
    };

    box.appendChild(group("source", [
      ["counter", "Counter", "A zero-padded number, unique within the job"],
      ["filename", "Original file name", "The source file's own name, so the camera's clip name stays recoverable"],
    ]));
    box.appendChild(group("position", [
      ["end", "At the end", "Appended after the pattern"],
      ["front", "At the front", "Prepended before the pattern"],
    ]));
    return box;
  }

  /**
   * Split the previewed file name around the suffix main says it added, so
   * that part can be marked. Returns null when there is nothing to mark.
   *
   * Located by position rather than by pattern: `front` means the name
   * starts with `${value}_`, `end` means the stem ends with `_${value}`.
   * Both are checked against what main reported rather than guessed, so a
   * user value that merely looks like a counter is never mistaken for one.
   */
  function markAutoSuffix(res) {
    const info = res.autoCounter && res.autoSuffix;
    if (!info || !info.value) return null;
    const name = String(res.file);
    const title = info.source === "filename"
      ? "Added automatically: the pattern numbers nothing, so the original file name keeps each one distinct"
      : "Added automatically: the pattern numbers nothing, so files would otherwise collide";

    if (info.position === "front") {
      const lead = `${info.value}_`;
      if (!name.startsWith(lead)) return null;
      return [
        el("span", { class: "auto-fix", text: lead, title }),
        document.createTextNode(name.slice(lead.length)),
      ];
    }
    // End: the suffix sits on the stem, before the extension the mapper
    // re-adds afterwards.
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    const tail = `_${info.value}`;
    if (!stem.endsWith(tail)) return null;
    const out = [
      document.createTextNode(stem.slice(0, stem.length - tail.length)),
      el("span", { class: "auto-fix", text: tail, title }),
    ];
    if (ext) out.push(document.createTextNode(ext));
    return out;
  }

  /**
   * The option list for one Choice field (§65.1).
   *
   * Label and Token are separate because they read best differently: a full
   * name belongs in a dropdown, a short code belongs in a filename. Token
   * is optional and falls back to the label, so the common case where they
   * are the same costs nothing to author.
   */
  function renderChoiceOptions(f) {
    const box = el("div", { class: "choice-options" });
    f.options = Array.isArray(f.options) ? f.options : [];

    const head = el("div", { class: "choice-head" }, [
      el("span", { text: "Options" }),
      el("span", { class: "choice-col", text: "Label" }),
      el("span", { class: "choice-col", text: "Token (optional)" }),
    ]);
    box.appendChild(head);

    if (!f.options.length) {
      box.appendChild(el("div", { class: "token-help", text: "No options yet." }));
    }

    f.options.forEach((opt, i) => {
      const r = el("div", { class: "choice-row" });

      const label = el("input");
      label.type = "text";
      label.placeholder = "Mathias";
      label.value = opt.label || "";
      label.addEventListener("input", () => {
        opt.label = label.value;
        tokenHint();
      });
      r.appendChild(label);

      const token = el("input");
      token.type = "text";
      token.placeholder = opt.label ? opt.label : "MS";
      token.value = opt.token || "";
      token.addEventListener("input", () => { opt.token = token.value; });
      r.appendChild(token);
      // The placeholder shows what a blank Token will actually render as,
      // so the fallback is visible rather than something to remember.
      function tokenHint() { token.placeholder = opt.label || "MS"; }

      const controls = el("div", { class: "choice-row-controls" });
      const up = el("button", { class: "icon-btn", title: "Move up", disabled: i === 0,
        onClick: () => { const [m] = f.options.splice(i, 1); f.options.splice(i - 1, 0, m); renderPresetPane(); } });
      up.textContent = "\u2191";
      controls.appendChild(up);
      const down = el("button", { class: "icon-btn", title: "Move down", disabled: i === f.options.length - 1,
        onClick: () => { const [m] = f.options.splice(i, 1); f.options.splice(i + 1, 0, m); renderPresetPane(); } });
      down.textContent = "\u2193";
      controls.appendChild(down);
      const del = el("button", { class: "icon-btn", title: "Remove option",
        onClick: () => { f.options.splice(i, 1); renderPresetPane(); } });
      del.appendChild(icon("close"));
      controls.appendChild(del);
      r.appendChild(controls);

      box.appendChild(r);
    });

    box.appendChild(el("button", {
      class: "choice-add",
      text: "Add option",
      onClick: () => { f.options.push({ label: "", token: "" }); renderPresetPane(); },
    }));

    const otherWrap = el("label", { class: "req choice-other" });
    const other = el("input");
    other.type = "checkbox";
    other.checked = Boolean(f.allowOther);
    other.addEventListener("change", () => { f.allowOther = other.checked; });
    otherWrap.appendChild(other);
    otherWrap.appendChild(el("span", { text: "Offer \u201cOther\u2026\u201d for one-off values not on this list" }));
    box.appendChild(otherWrap);

    return box;
  }

  function renderPresetPane() {
    onSelectionChange(Boolean(editingPreset && editingPreset.id));
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
      for (const [v, t] of [["text", "Text"], ["choice", "Choice"]]) {
        const o = el("option", { text: t });
        o.value = v;
        if (f.type === v) o.selected = true;
        type.appendChild(o);
      }
      type.title = "Choice fields offer a list you write here";
      type.addEventListener("change", () => {
        f.type = type.value;
        if (f.type === "choice" && !Array.isArray(f.options)) f.options = [];
        renderPresetPane();
      });
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
      if (f.type === "choice") fieldsBox.appendChild(renderChoiceOptions(f));
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
      patternBox.appendChild(el("div", {
        id: key === "fileTemplate" ? "tpl-preview-file" : "tpl-preview-folder",
        class: "tpl-preview",
      }));

      // §77 — directly under the file-name field, because that is the only
      // pattern this affects and it explains the amber text in the preview
      // immediately above it.
      if (key === "fileTemplate") patternBox.appendChild(renderAutoSuffix());
    }

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

    host.appendChild(renderFolderStructure());

    const filterBox = section("Filtering");
    filterBox.appendChild(renderFilterBlock());
    host.appendChild(filterBox);

    // §62 — Delete is no longer rendered here. It sits beside Save in the
    // window's own toolbar, because a destructive action at the far bottom
    // of a scrolling pane is both hard to find and easy to hit by accident
    // on the way past.
    refreshPresetPreview();
  }

  function renderFilterBlock() {
    const f = editingPreset.filters || {};
    // ignoreFolders deliberately no longer counts here (§62): its control
    // moved out to its own section, so a preset that only flattens would
    // otherwise open — and shout "ON" about — a section that no longer
    // contains the thing that is on.
    const active =
      (f.doNotCopyExtensions || []).length ||
      (f.doNotCopyNames || []).length ||
      (f.ignoreBundles?.extensions || []).length;

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

    return block;
  }

  /**
   * §62 — folder structure, lifted out of the Filtering block.
   *
   * It was nested under "File filtering", collapsed by default, which put
   * a decision about where every file lands behind a section about which
   * files are skipped. Only one of its three values has anything to do
   * with filtering ("Skip folders left empty by filtering"), and that one
   * is the exception, not the reason it lived there.
   *
   * Still writes into `filters.ignoreFolders`, because that is where the
   * engine reads it — moving the STORAGE would be a data change, and this
   * is a placement fix.
   */
  function renderFolderStructure() {
    const box = section("Folder structure");
    const f = editingPreset.filters || {};
    const row = el("div", { class: "filter-row" });
    row.appendChild(el("label", { text: "Folders" }));
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
    select.addEventListener("change", () => {
      editingPreset.filters = editingPreset.filters || {};
      editingPreset.filters.ignoreFolders = { mode: select.value };
    });
    row.appendChild(select);
    box.appendChild(row);
    box.appendChild(el("div", {
      class: "token-help",
      text: "Flattening discards the card's own DCIM/CLIP folders. Two files with the same name "
          + "in different folders would collide, and the job is refused rather than one of them "
          + "being overwritten.",
    }));
    return box;
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
    // §65c — refused before it can ever be attached to a job. Decided by
    // main, so the editor and the engine cannot disagree about what is
    // allowed.
    const { error } = await window.freeframe.validateFolderPattern(editingPreset.folderTemplate);
    if (error) return { ok: false, error };
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

  /** Delete the preset currently open. The main window clears its own
   *  active selection off the presets:changed broadcast — it owns that
   *  state, this window does not, and reaching across would be the drift
   *  this extraction exists to avoid. */
  async function deleteCurrent() {
    if (!editingPreset || !editingPreset.id) return { ok: false };
    await window.freeframe.deletePreset(editingPreset.id);
    editingPreset = null;
    await reloadPresets();
    return { ok: true };
  }

  function startNew() {
    editingPreset = newPresetDraft();
    renderPresetList();
    renderPresetPane();
  }

  return {
    init({ sampleSourcePath, onSelectionChange: cb } = {}) {
      if (sampleSourcePath) sampleSource = sampleSourcePath;
      if (cb) onSelectionChange = cb;
      return reloadPresets();
    },
    reload: reloadPresets,
    save,
    deleteCurrent,
    startNew,
    hasDraft: () => Boolean(editingPreset),
  };
})();
