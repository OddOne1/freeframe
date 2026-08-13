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

  function fmtDuration(ms) {
    if (!ms || ms < 0) return "";
    if (ms < 1000) return `${ms} ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
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
   * `expanded` is a Set of job ids whose detail is open, owned by the
   * caller so it survives re-renders (a job updating twice a second must
   * not close a row the user just opened).
   */
  function renderJobs(host, snapshot, { expanded, onCancel, onToggle } = {}) {
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
      const isOpen = expanded && expanded.has(j.id);

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
      }

      const row = el("div", { class: `job-row${isOpen ? " open" : ""}` }, [head]);
      row.addEventListener("click", () => onToggle && onToggle(j.id));

      if (j.status === "running") {
        const pct = typeof p.percent === "number" ? Math.max(0, Math.min(100, p.percent)) : 0;
        row.appendChild(el("div", { class: "job-bar" }, [
          el("div", { style: `width:${pct}%` }),
        ]));
      }

      if (isOpen) {
        const detail = el("div", { class: "job-detail" });
        detail.appendChild(el("div", { text: `From  ${j.sourceLabel || "—"}` }));
        detail.appendChild(el("div", { text: `To    ${(j.destLabels || []).join(", ") || "—"}` }));
        detail.appendChild(el("div", { text: `Runs alongside  ${MODE_LABEL[j.mode] || j.mode}` }));
        if (p.file) detail.appendChild(el("div", { text: `Current  ${p.file}` }));
        if (p.phase) detail.appendChild(el("div", { text: `Phase  ${p.phase}` }));
        if (j.error) detail.appendChild(el("div", { class: "job-error", text: j.error }));
        if (j.summary) {
          const s = j.summary;
          if (s.uploadOnly) {
            detail.appendChild(el("div", {
              class: "job-warn",
              text: `Uploaded ${s.filesCopied ?? 0}/${s.totalFiles ?? 0} — not verified against FreeFrame.`,
            }));
          } else {
            detail.appendChild(el("div", {
              class: s.allVerified ? "job-ok" : "job-error",
              text: s.allVerified
                ? `Verified ${s.fileCopiesVerified}/${s.totalFileCopies} — safe to wipe the source.`
                : `Not fully verified — ${s.mismatches?.length ?? 0} mismatch(es), ${s.errors?.length ?? 0} error(s).`,
            }));
          }
        }
        row.appendChild(detail);
      }

      host.appendChild(row);
    }
  }

  window.JobPanel = { renderJobs, fmtBytes };
})();
