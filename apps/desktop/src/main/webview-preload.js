// Preload for the embedded FreeFrame web view (§60b).
//
// Runs in an isolated world before any page script on every navigation
// inside the view. That timing is the whole point: the web app reads
// `ff_access_token` out of localStorage as it boots, so injecting after
// `did-finish-load` would race its own auth check and usually lose.
//
// Writes the SAME keys and cookies `apps/web/lib/auth.ts`'s setTokens()
// writes — matched field for field, because a near-miss here logs the user
// out in a way that looks like a server problem.
//
// INJECTS ONCE PER VIEW LIFETIME, not once per navigation. The marker
// lives in sessionStorage, which survives navigation within the view and
// dies with the view. That is what makes "log out inside the web view"
// mean something: without the guard, the next click would silently sign
// the user back in and the logout button would look broken.

const ACCESS_KEY = "ff_access_token";
const REFRESH_KEY = "ff_refresh_token";
const MARKER = "ff_desktop_sso_injected";
const WEEK = 60 * 60 * 24 * 7;

function argFor(prefix) {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
}

try {
  const access = argFor("--ff-access=");
  const refresh = argFor("--ff-refresh=");
  // No tokens means the desktop app itself is logged out. Deliberately do
  // nothing: the embedded app then shows its own login page, which is the
  // stated design — there is no second login UI in this app.
  if (access && refresh && !sessionStorage.getItem(MARKER)) {
    localStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
    document.cookie = `${ACCESS_KEY}=${access}; path=/; max-age=${WEEK}; SameSite=Lax`;
    document.cookie = `${REFRESH_KEY}=${refresh}; path=/; max-age=${WEEK}; SameSite=Lax`;
    sessionStorage.setItem(MARKER, "1");
  }
} catch {
  /* A storage failure must not take the page down with it. */
}
