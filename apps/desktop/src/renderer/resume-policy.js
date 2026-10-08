// Which interrupted jobs resume by themselves, and which get asked about.
//
// §213 made automatic resume a product requirement ("auto-resume is a MUST
// for every user"), which turns what used to be one line — offer the
// newest candidate — into a real decision with five inputs. That decision
// lives here rather than inline in index.html for the reason panel.js's
// `uploadHeadline` does: it is the part that can be wrong in a way nobody
// notices, and index.html cannot be required by a test (it is a monolithic
// <script> in a page Electron loads).
//
// Pure. No IPC, no DOM, no clock. The caller supplies the summaries from
// `freeframe:interrupted-uploads` and acts on the answer.
(function (root) {
  "use strict";

  /**
   * @param {object} o
   * @param {Array}  o.docs      summaries from freeframe:interrupted-uploads
   * @param {"launch"|"source"} o.trigger
   * @param {boolean} o.autoResume   the autoResumeUploads setting
   * @param {boolean} o.loggedIn     is there a usable FreeFrame session
   * @param {Set<string>} o.alreadyOffered  jobIds this window has handled
   * @param {(doc:object)=>boolean} [o.matchesSource]
   *        for trigger "source": does this journal describe what is
   *        selected now. Required for "source", ignored for "launch".
   * @returns {{auto: Array, prompt: object|null}}
   *   `auto` — resume these without asking, in order. Each carries
   *   `startPaused`, because a job the user had paused must come back
   *   paused: auto-resume may not undo a deliberate stop.
   *   `prompt` — the one job to ask about, or null.
   */
  function planResumeSweep({
    docs,
    trigger,
    autoResume,
    loggedIn,
    alreadyOffered,
    matchesSource,
  }) {
    const offered = alreadyOffered || new Set();
    const candidates = (Array.isArray(docs) ? docs : [])
      .filter((d) => d && d.jobId && !offered.has(d.jobId))
      // §105A — parked by the user. Still resumable, still listed in the
      // notification bell; it just may not seize the window again. It may
      // not be auto-started either: parking is a decision, and overriding
      // it silently is worse than the modal that prompted the complaint.
      .filter((d) => d.hiddenFromPrompt !== true)
      .filter((d) => (trigger === "launch" ? true : Boolean(matchesSource && matchesSource(d))))
      .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));

    if (!candidates.length) return { auto: [], prompt: null };

    // UPLOADS ONLY, and only when signed in.
    //
    // A local copy's resume re-checks destination files it may not even be
    // able to see — an unplugged RAID, a card that is now a different
    // card — and §105B's prompt text is what tells the user what will be
    // re-checked against what. Starting that silently is a different and
    // larger decision than continuing an upload, so a copy always asks.
    //
    // Signed out, every file of an auto-started upload would park in
    // "Sign in to continue" without anyone having asked for anything. The
    // caller re-runs this sweep when a sign-in lands.
    if (!autoResume || !loggedIn) {
      return { auto: [], prompt: candidates[0] };
    }

    const auto = candidates
      .filter((d) => d.kind !== "copy")
      .map((d) => ({ ...d, startPaused: d.paused === true }));

    if (!auto.length) return { auto: [], prompt: candidates[0] };

    // Everything auto-resumable goes at once — they are independent jobs
    // and the queue already schedules them against each other (§18c).
    // Anything left is a copy, and copies are asked about one at a time,
    // same as before: comparing several interrupted jobs whose contents
    // you cannot see is not a question worth asking.
    const rest = candidates.filter((d) => d.kind === "copy");
    return { auto, prompt: rest.length ? rest[0] : null };
  }

  const api = { planResumeSweep };
  root.ResumePolicy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
