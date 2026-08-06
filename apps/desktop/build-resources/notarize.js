// electron-builder afterSign hook — runs `notarytool` against Apple's
// notarization service. This is the step that actually satisfies the
// "no admin password, no Settings" install requirement; signing alone
// isn't enough on current macOS.
//
// Skips gracefully (does not fail the build) when Apple credentials
// aren't configured, so `npm run build:mac:unsigned` keeps working for
// local dev before YON.Studio's Apple Developer Program account exists.
// Real distribution builds MUST have these three env vars set:
//   APPLE_ID                    — the Apple ID enrolled in the Developer
//                                  Program
//   APPLE_APP_SPECIFIC_PASSWORD — an app-specific password for that Apple
//                                  ID (appleid.apple.com → Sign-In and
//                                  Security → App-Specific Passwords),
//                                  NOT the account password itself
//   APPLE_TEAM_ID                — from developer.apple.com/account,
//                                  Membership details

const { notarize } = require("@electron/notarize");

exports.default = async function notarizeMac(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log(
      "[notarize] Skipping — APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID " +
        "not set. This build is NOT notarized and will trigger Gatekeeper's " +
        "admin-password/Settings flow on any other Mac. Fine for local dev " +
        "(npm run build:mac:unsigned), not fine to hand to anyone else."
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;

  console.log(`[notarize] Submitting ${appName} to Apple — this can take a few minutes...`);

  await notarize({
    appBundleId: "studio.yon.freeframe.desktop",
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log(`[notarize] Done. ${appName} is notarized.`);
};
