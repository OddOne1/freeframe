// Guaranteed teardown for Electron processes spawned by the e2e scripts.
//
// Every e2e-*.js spawns a real Electron and drives it over CDP. Seven of
// them killed it only on the happy-path tail of the script, with nothing
// but a top-level `.catch(e => process.exit(1))` that never referenced the
// child — so any failed assertion or thrown error above the kill line left
// a live Electron running, eating RAM and sitting in the Dock.
//
// That was not theoretical. Several scripts already `pkill -f
// 'remote-debugging-port=...'` before spawning, which is a workaround for
// processes leaked by *earlier runs*, not a fix. It also produced a real
// false result during the §22 work: two stray instances from an earlier
// probe reported 248px for an element the clean run measured at 190px.
//
// Deliberately a shared helper rather than seven bespoke try/finally
// rewrites. Each script has a different shape, cleanup drifts as they get
// copy-pasted (which is how this happened), and a handler installed at the
// moment of spawn covers the window a try/finally around the body cannot:
// a throw between spawning and entering the try.
//
// Wrapping the spawn is the whole integration — no test body moves, so
// nothing any script asserts can change.
//
//   const child = spawnElectron(ELECTRON, args, opts);
//
// package.json's `pretest`/`posttest` run `kill-strays` as a net around the
// suite, but that is defence in depth and NOT a substitute for this:
// verified during this change that **posttest does not run when the test
// script fails**, which is precisely when a leak happens. `pretest` still
// clears anything a previous failed run left behind.

const { spawn } = require("node:child_process");
const fs = require("node:fs");

const children = new Set();
let installed = false;

/**
 * Kill the whole process GROUP, not the child handle.
 *
 * This is the part that actually matters, and it is not obvious:
 * `node_modules/.bin/electron` is a Node shim that spawns the real
 * Electron binary as its own child. `child.kill()` therefore kills the
 * shim and leaves the real app running, reparented to init — which is why
 * a script that killed its child on the happy path STILL left an Electron
 * in the Dock, and why several scripts grew `pkill` workarounds.
 *
 * Verified by inspection during this change: after a plain child.kill(),
 * the surviving Electron's PPID was 1.
 *
 * SIGKILL, not SIGTERM: a hung renderer can ignore a polite request, and
 * this runs at process exit where there is no time to escalate.
 */
function killAll() {
  for (const { pid, child } of children) {
    try {
      // Negative pid = the process group, which only exists as a separate
      // group because spawnElectron passes `detached: true`.
      process.kill(-pid, "SIGKILL");
    } catch {
      // ESRCH (already gone) or a child that wasn't detached.
      try { if (child && !child.killed) child.kill("SIGKILL"); } catch { /* gone */ }
    }
  }
  children.clear();
}

function install() {
  if (installed) return;
  installed = true;

  // Runs for every exit path a script can take: falling off the end,
  // process.exit() from a failed assertion, or an error the script's own
  // .catch() re-raises. Must stay synchronous — async work in an 'exit'
  // handler never runs.
  process.on("exit", killAll);

  // Signals do not trigger 'exit' on their own, so Ctrl-C would otherwise
  // orphan the child. 130 is the conventional code for SIGINT.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => { killAll(); process.exit(130); });
  }

  // Only reached if a script has no handler of its own; the ones that do
  // still win, and their exit then triggers the 'exit' handler above.
  process.on("uncaughtException", (err) => {
    killAll();
    console.error("\nUNCAUGHT", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    killAll();
    console.error("\nUNHANDLED REJECTION", err);
    process.exit(1);
  });
}

/**
 * Register a spawned child for guaranteed teardown, and return it
 * unchanged so it can wrap the spawn call in place.
 */
function trackChild(child) {
  install();
  // The pid is kept, and the entry is deliberately NEVER removed when the
  // child exits. A script that SIGKILLs its own child kills only the shim
  // — the real Electron survives in the same process GROUP, so the group
  // still needs killing after the handle is dead. Dropping the entry on
  // 'exit' looked tidy and silently reintroduced the leak in exactly the
  // scripts that were trying hardest to clean up after themselves.
  //
  // Group-killing a pid that has fully exited raises ESRCH, which killAll
  // swallows; the window for that pid to be reused inside one test run is
  // not realistic, and a reused pid would not be a group leader anyway.
  children.add({ pid: child.pid, child });
  return child;
}

/**
 * Spawn Electron so it can actually be killed later.
 *
 * `detached: true` is load-bearing, not a style choice: it makes the child
 * a process-group leader, which is the only way to reach the real Electron
 * binary the .bin/electron shim spawns underneath it (see killAll above).
 *
 * The usual objection to `detached` — that the child outlives its parent —
 * is exactly what was already happening by accident, and is now handled
 * deliberately by the exit handlers plus the `kill-strays` net in
 * package.json.
 *
 * Drop-in for `spawn(...)`: same three arguments, same returned child.
 */
function spawnElectron(command, args, options = {}) {
  // Fail loudly on a missing binary. spawn()'s ENOENT arrives asynchronously
  // as an 'error' event, so without this the harness carries on, finds no
  // CDP target, and reports whatever its own timeout path reports — which
  // is a confusing way to learn that node_modules/.bin lost a symlink.
  if (!fs.existsSync(command)) {
    throw new Error(
      `Electron not found at ${command}. ` +
      "Run `pnpm install` (the workspace .bin links live under apps/desktop/node_modules/.bin).",
    );
  }
  return trackChild(spawn(command, args, { ...options, detached: true }));
}

/** Test-only view of what is still registered. */
function trackedCount() {
  return children.size;
}

module.exports = { trackChild, spawnElectron, trackedCount };
