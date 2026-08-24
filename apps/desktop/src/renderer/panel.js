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
    queued: "Queued", running: "Running", done: "Done",
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

  /**
   * Render the whole job list into `host`.
   *
   * Every row shows its full state permanently — there is no per-row
   * expand. Seeing more means making the PANEL taller (the drag handle on
   * its top edge), not opening one row at a time. That also removes a
   * hazard the click-toggle had: the verification verdict, the one thing
   * this app exists to report, was hidden behind a click.
   */
  function renderJobs(host, snapshot, { onCancel, onOpenLog, onRemove } = {}) {
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
        el("span", { class: "job-status", text: STATUS_LABEL[j.status] || j.status }),
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
      if (j.status !== "queued" && j.status !== "running") {
        const d = fmtDuration((j.finishedAt || 0) - (j.startedAt || 0));
        if (d) bits.push(d);
      }
      head.appendChild(el("span", { class: "job-meta", text: bits.join(" · ") }));

      if (j.status === "running" || j.status === "queued") {
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
      } else if (j.summary) {
        const s = j.summary;
        if (s.uploadOnly) {
          state = el("span", {
            class: "job-state job-warn",
            text: `Uploaded ${s.filesCopied ?? 0}/${s.totalFiles ?? 0} — not verified against FreeFrame.`,
          });
        } else {
          state = el("span", {
            class: `job-state ${s.allVerified ? "job-ok" : "job-error"}`,
            text: s.allVerified
              ? `Verified ${s.fileCopiesVerified}/${s.totalFileCopies} — safe to wipe the source.`
              : `Not fully verified — ${s.mismatches?.length ?? 0} mismatch(es), ${s.errors?.length ?? 0} error(s).`,
          });
        }
      }
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

      host.appendChild(row);
    }
  }

  window.JobPanel = { renderJobs, fmtBytes };
})();
