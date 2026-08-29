// Shared job-panel rendering, used by BOTH the docked tab in index.html
// and the detached window (panel.html).
//
// One implementation on purpose: two renderings of the same job list is
// how the docked and detached views end up disagreeing about what is
// running, which is exactly the thing a progress panel must never do.
//
// Plain script, no module system — the renderer has no bundler, so this
// is loaded with a <script> tag in both documents and hangs one function
// off window.
(function () {
  function fmtBytes(b) {
    if (b == null) return "—";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0, n = b;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
    return `${n.toFixed(1)} ${u[i]}`;
  }

  /** Coarse on purpose: this is an estimate from a five-second window, and
   *  reporting it to the second invites more trust than it has earned. */
  function fmtEta(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
    if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
    const m = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  function fmtDuration(ms) {
    if (!ms || ms < 0) return "";
    if (ms < 1000) return `${ms} ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  }

  // Wall-clock, local, 24h. "Started 14:32:08" answers a different
  // question from "12.4s" — which of tonight's offloads this row is —
  // so both are shown, not one instead of the other.
  function fmtClock(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
  }

  const STATUS_LABEL = {
    queued: "Queued", running: "Running", paused: "Paused", done: "Done",
    failed: "Failed", cancelled: "Cancelled",
  };

  const MODE_LABEL = {
    free: "Any", source: "Same source", destination: "Same destination",
  };

  function el(tag, opts = {}, kids = []) {
    const n = document.createElement(tag);
    if (opts.class) n.className = opts.class;
    if (opts.text != null) n.textContent = opts.text;
    if (opts.title) n.title = opts.title;
    if (opts.style) n.setAttribute("style", opts.style);
    if (opts.onClick) n.addEventListener("click", opts.onClick);
    for (const k of kids) if (k) n.appendChild(k);
    return n;
  }

  const baseName = (p) => String(p || "").split("/").filter(Boolean).pop() || String(p || "");
  const NODE_STATUS_LABEL = {
    pending: "Waiting", copying: "Copying", verifying: "Verifying",
    verified: "Verified", failed: "Failed", skipped: "Skipped",
  };
  const statusLabel = (st) => NODE_STATUS_LABEL[st] || "Ready";

  /**
   * §71 — the completion detail, rendered INTO a job's own Log row.
   *
   * Moved here from index.html, where it filled a separate `#summary`
   * card below the Log. It lives in panel.js rather than behind a
   * callback so the detached window gets the same detail as the docked
   * one — two renderings of the same job is the thing this file exists
   * to prevent.
   */
  function renderSummary(s, box) {
    box.replaceChildren();
    // Items 1 & 2 — an upload summary is a different shape AND a
    // different guarantee, and rendering it through the local-copy
    // vocabulary made a working upload read as a failed copy.
    const isUpload = Boolean(s.uploadOnly);
    const uploadOk = isUpload && !s.cancelled && s.errors.length === 0 && s.filesCopied === s.totalFiles;
    const good = isUpload ? uploadOk : s.allVerified;

    box.appendChild(el("div", { class: "head" }, [
      el("h3", {
        // Never "verified" for an upload: nothing has been read back
        // from FreeFrame and compared. See the verdict text below.
        class: good ? "ok" : "bad",
        text: isUpload
          ? (uploadOk ? "Upload complete" : "Upload finished with problems")
          : (good ? "Copy verified" : "Copy finished with problems"),
      }),
    ]));

    const stats = el("div", { class: "stats" });
    const stat = (k, v) => stats.appendChild(el("span", {}, [
      document.createTextNode(`${k} `), el("b", { text: v }),
    ]));
    stat("Files", `${s.totalFiles}`);
    // "Verified" means re-read from the destination and hash-matched.
    // An upload has done no such thing — the count is "the upload call
    // returned", which is a weaker claim and needs a weaker word.
    if (isUpload) stat("Uploaded", `${s.filesCopied ?? s.fileCopiesVerified}/${s.totalFiles}`);
    else stat("Verified", `${s.fileCopiesVerified}/${s.totalFileCopies}`);
    // Item 1 — an upload tracks no per-node cascade state, so nodes is
    // empty by design and the real target lives in destPaths. Reading
    // nodes.length for both is why a real upload said "Destinations 0".
    stat("Destinations", `${isUpload ? (s.destPaths || []).length : s.nodes.length}`);
    // Item 4 — "Legs" is cascade jargon and irrelevant to the vast
    // majority of jobs, which have exactly one.
    if (s.legCount > 1) stat("Cascade Legs", `${s.legCount}`);
    stat("Data", fmtBytes(s.copiedBytes));
    stat("Duration", s.durationMs < 1000 ? `${s.durationMs} ms` : `${(s.durationMs / 1000).toFixed(1)}s`);
    if (s.mismatches.length) stat("Mismatches", `${s.mismatches.length}`);
    if (s.errors.length) stat("Errors", `${s.errors.length}`);
    box.appendChild(stats);

    // Per-node outcome, so a partially-failed cascade is legible at a
    // glance rather than hidden behind one aggregate number.
    for (const n of s.nodes) {
      const parent = n.parentId ? s.nodes.find((x) => x.id === n.parentId) : null;
      box.appendChild(el("div", { class: "stats", style: "margin-top:4px" }, [
        el("span", { class: `dot ${n.status}`, style: "display:inline-block;margin-right:6px" }),
        el("span", { text: `${baseName(n.path)}${parent ? ` (from ${baseName(parent.path)})` : ""} — ${statusLabel(n.status)}` }),
      ]));
    }

    // Assets the server couldn't hand over as originals. Shown even on a
    // fully-verified job, and deliberately not folded into the mismatch
    // list: nothing went wrong with these files, they were never
    // attempted — and "Copy verified" must not be readable as
    // "everything came down" when it isn't.
    if (s.skippedAssets && s.skippedAssets.length) {
      box.appendChild(el("div", {
        class: "verdict bad",
        style: "margin-top:8px",
        text: `${s.skippedAssets.length} asset${s.skippedAssets.length === 1 ? " was" : "s were"} not pulled — ` +
          `this offload is not a complete copy of the folder.`,
      }));
      const sl = el("ul");
      for (const a of s.skippedAssets.slice(0, 8)) {
        sl.appendChild(el("li", { text: `${a.name} — ${a.reason}` }));
      }
      if (s.skippedAssets.length > 8) {
        sl.appendChild(el("li", { text: `…and ${s.skippedAssets.length - 8} more` }));
      }
      box.appendChild(sl);
    }

    // §23c. Files the preset's filter chose not to take. Neutral, not a
    // failure — but stated, because the difference between a tool that
    // skips files and one that loses them is whether it tells you.
    if (s.filteredOut && s.filteredOut.length) {
      box.appendChild(el("div", {
        class: "verdict warn",
        style: "margin-top:8px",
        text: `${s.filteredOut.length} file${s.filteredOut.length === 1 ? " was" : "s were"} skipped by this preset's ` +
          `filter and are NOT in the destination.`,
      }));
      const fl = el("ul");
      for (const f of s.filteredOut.slice(0, 8)) {
        fl.appendChild(el("li", { text: `${f.rel} — ${f.reason}` }));
      }
      if (s.filteredOut.length > 8) {
        fl.appendChild(el("li", { text: `…and ${s.filteredOut.length - 8} more` }));
      }
      box.appendChild(fl);
    }

    const problems = [...s.mismatches, ...s.errors];
    if (problems.length) {
      const ul = el("ul");
      for (const p of problems.slice(0, 8)) {
        ul.appendChild(el("li", {
          text: p.destHash !== undefined
            ? `${p.file} → ${baseName(p.destRoot)}: expected ${p.sourceHash}, got ${p.destHash ?? "—"}`
            : `${p.file ? p.file + " " : ""}${p.destRoot ? "→ " + baseName(p.destRoot) : ""}: ${p.error}`,
        }));
      }
      if (problems.length > 8) ul.appendChild(el("li", { text: `…and ${problems.length - 8} more` }));
      box.appendChild(ul);
    }

    // Item 2 — an upload gets its own verdict. `allVerified: false` is
    // correct and deliberate for uploads (nothing has been read back
    // from FreeFrame and compared), but the local-copy wording read as
    // an active failure rather than "this destination type is honestly
    // less mature". The claim is weakened, not the honesty: this still
    // does not say "verified", because it isn't.
    box.appendChild(el("div", {
      class: `verdict ${good ? (isUpload ? "warn" : "ok") : "bad"}`,
      text: isUpload
        ? (uploadOk
            ? "Uploaded — not yet independently verified against FreeFrame. Checksum verification for this destination type isn't built yet, so keep the source until you've confirmed the files yourself."
            : "Upload did not finish — some files were not sent. Keep the source.")
        : (good
            ? "Every file was re-read from each destination and matched the source. Safe to wipe the card."
            : "Not every destination verified — do NOT wipe the source until this is resolved."),
    }));
  }

  /**
   * Render the whole job list into `host`.
   *
   * Every row shows its full state permanently — there is no per-row
   * expand. Seeing more means making the PANEL taller (the drag handle on
   * its top edge), not opening one row at a time. That also removes a
   * hazard the click-toggle had: the verification verdict, the one thing
   * this app exists to report, was hidden behind a click.
   */
  function renderJobs(host, snapshot, { onCancel, onOpenLog, onRemove, onPause, onResume } = {}) {
    host.replaceChildren();

    if (!snapshot || snapshot.length === 0) {
      host.appendChild(el("p", { class: "jobs-empty", text: "No transfers yet." }));
      return;
    }

    // Running first, then queued, then finished newest-first — the order
    // someone scanning the panel actually cares about.
    const rank = { running: 0, queued: 1 };
    const rows = [...snapshot].sort((a, b) => {
      const ra = rank[a.status] ?? 2, rb = rank[b.status] ?? 2;
      if (ra !== rb) return ra - rb;
      return (b.finishedAt || b.startedAt || b.createdAt) - (a.finishedAt || a.startedAt || a.createdAt);
    });

    for (const j of rows) {
      const p = j.progress || {};

      const head = el("div", { class: "job-head" }, [
        el("span", { class: `job-dot ${j.status}` }),
        el("span", { class: "job-label", text: j.label, title: j.sourceLabel }),
        // §96 — "Cancelling…" while the stop is still catching up. The
        // engine only checks between files, so a large clip mid-copy keeps
        // going after the click; without this the row said "Running" the
        // whole time and the button looked ignored.
        //
        // Applied to a PAUSED row too, not just a running one: §95 made a
        // paused job cancellable, and the prompt for this predates that.
        // Text only, same dot as before — a new colour would read as a new
        // outcome rather than as the same one arriving.
        el("span", {
          class: "job-status",
          text: j.cancelling && (j.status === "running" || j.status === "paused")
            ? "Cancelling…"
            : STATUS_LABEL[j.status] || j.status,
        }),
      ]);

      // Cascading chains report their leg count per row, matching the
      // single-job summary's "Cascade Legs" stat.
      const legs = (j.summary && j.summary.legCount) || p.legCount || 1;
      const bits = [];
      if (j.kind === "upload") bits.push("Upload");
      else if (j.kind === "download") bits.push("Download");
      if (legs > 1) bits.push(`${legs} cascade legs`);
      if (p.totalFiles != null) bits.push(`${p.totalFiles} files`);
      if (p.copiedBytes != null) bits.push(fmtBytes(p.copiedBytes));
      // §58. Only while running: a speed on a finished row would be
      // describing something that stopped happening.
      if (j.status === "running") {
        if (typeof p.speed === "number" && p.speed > 0) bits.push(`${fmtBytes(p.speed)}/s`);
        const eta = fmtEta(p.eta);
        if (eta) bits.push(`${eta} remaining`);
      }
      if (j.status === "queued" && j.blockedBy && j.blockedBy.length) {
        bits.push(`waiting on ${j.blockedBy.join(", ")}`);
      }
      // §95 — why a resume was refused, said in the row rather than left
      // as a button that appears to do nothing.
      if (j.statusNote) bits.push(j.statusNote);
      // A paused job has not finished, so it has no duration to report —
      // subtracting from a null finishedAt would print the epoch.
      if (j.status !== "queued" && j.status !== "running" && j.status !== "paused") {
        const d = fmtDuration((j.finishedAt || 0) - (j.startedAt || 0));
        if (d) bits.push(d);
      }
      head.appendChild(el("span", { class: "job-meta", text: bits.join(" · ") }));

      if (j.status === "running" || j.status === "queued" || j.status === "paused") {
        // §95 — Pause on a running job, Resume on a paused one. Only ever
        // one of the two, beside Cancel, which stays available in both
        // states: a paused job that could not be cancelled would be a trap.
        if (j.status === "running" && onPause) {
          head.appendChild(el("button", {
            class: "job-pause", text: "Pause", title: "Stop after the current file",
            onClick: (e) => { e.stopPropagation(); onPause(j.id); },
          }));
        } else if (j.status === "paused" && onResume) {
          head.appendChild(el("button", {
            class: "job-pause", text: "Resume", title: "Continue from the next file",
            onClick: (e) => { e.stopPropagation(); onResume(j.id); },
          }));
        }
        head.appendChild(el("button", {
          class: "job-cancel", text: "Cancel",
          onClick: (e) => { e.stopPropagation(); onCancel && onCancel(j.id); },
        }));
      } else if (onRemove) {
        // Only on a finished row (§59). Cancel and Remove are different
        // verbs, and a row that offered both would invite reading the ×
        // as "stop this".
        head.appendChild(el("button", {
          class: "job-remove", text: "×", title: "Remove from history",
          onClick: (e) => { e.stopPropagation(); onRemove(j.id); },
        }));
      }

      // From / to / mode live in the tooltip: useful, but not worth a
      // line of every row once the row can no longer be expanded.
      const row = el("div", {
        class: "job-row",
        title: [
          `From  ${j.sourceLabel || "—"}`,
          `To    ${(j.destLabels || []).join(", ") || "—"}`,
          `Runs alongside  ${MODE_LABEL[j.mode] || j.mode}`,
        ].join("\n"),
      }, [head]);

      if (j.status === "running") {
        const pct = typeof p.percent === "number" ? Math.max(0, Math.min(100, p.percent)) : 0;
        row.appendChild(el("div", { class: "job-bar" }, [
          el("div", { style: `width:${pct}%` }),
        ]));
      }

      // ── Always-visible second line: when, and how it went ──
      const times = [];
      if (j.startedAt) times.push(`Started ${fmtClock(j.startedAt)}`);
      else if (j.createdAt) times.push(`Queued ${fmtClock(j.createdAt)}`);
      if (j.finishedAt) times.push(`Finished ${fmtClock(j.finishedAt)}`);

      const sub = el("div", { class: "job-sub" }, [
        el("span", { class: "job-times", text: times.join(" · ") }),
      ]);

      let state = null;
      if (j.status === "running" && p.file) {
        state = el("span", { class: "job-state", text: p.file, title: p.file });
      } else if (j.status === "running" && p.phase) {
        state = el("span", { class: "job-state", text: p.phase });
      } else if (j.error) {
        state = el("span", { class: "job-state job-error", text: j.error });
      }
      // §71 — a finished job's own row carries the full completion detail
      // that used to appear as a separate card below the Log. The one-line
      // verdict this replaces said less and said it twice.
      if (state) sub.appendChild(state);

      // Only once the log actually exists on disk — an "Open Log" button
      // that opens nothing is worse than no button.
      if (j.logPath) {
        sub.appendChild(el("button", {
          class: "job-log", text: "Open Log", title: j.logPath,
          onClick: (e) => { e.stopPropagation(); onOpenLog && onOpenLog(j.id); },
        }));
      }
      row.appendChild(sub);

      if (j.summary && j.status !== "running" && j.status !== "queued") {
        const detail = el("div", { class: "job-summary" });
        renderSummary(j.summary, detail);
        row.appendChild(detail);
      }

      host.appendChild(row);
    }
  }

  window.JobPanel = { renderJobs, fmtBytes };
})();
