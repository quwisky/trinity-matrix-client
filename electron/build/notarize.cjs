// electron-builder `afterSign` hook: notarize the signed macOS .app with Apple's
// notary service (notarytool, via @electron/notarize).
//
// Design: this is a clean NO-OP unless notarization credentials are present in the
// environment. That keeps unsigned / ad-hoc local dev builds working — the unsigned
// `package:mac` script runs with CSC_IDENTITY_AUTO_DISCOVERY=false and no Apple creds,
// so this hook logs "skipping" and returns. It also only acts on the macOS .app.
//
// Two credential styles are supported (App Store Connect API key is preferred —
// it's keychain-free and CI-friendly):
//
//   App Store Connect API key:
//     APPLE_API_KEY     — path to the AuthKey_XXXXXXXXXX.p8 file
//     APPLE_API_KEY_ID  — the key's 10-char Key ID
//     APPLE_API_ISSUER  — the issuer UUID (App Store Connect → Users and Access → Keys)
//
//   Apple ID:
//     APPLE_ID                    — Apple ID email
//     APPLE_APP_SPECIFIC_PASSWORD — an app-specific password (appleid.apple.com)
//     APPLE_TEAM_ID               — the Developer Team ID (e.g. ABCDE12345)

const path = require('node:path');

/**
 * Resolve notarization credentials from an env-like object.
 * @returns {{ style: string, credentials: object } | null} null when none present.
 */
function resolveCredentials(env) {
  const apiKey = env.APPLE_API_KEY;
  const apiKeyId = env.APPLE_API_KEY_ID;
  const apiIssuer = env.APPLE_API_ISSUER;
  if (apiKey && apiKeyId && apiIssuer) {
    return {
      style: 'App Store Connect API key',
      credentials: {
        appleApiKey: apiKey,
        appleApiKeyId: apiKeyId,
        appleApiIssuer: apiIssuer,
      },
    };
  }

  const appleId = env.APPLE_ID;
  const appleIdPassword = env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = env.APPLE_TEAM_ID;
  if (appleId && appleIdPassword && teamId) {
    return {
      style: 'Apple ID',
      credentials: { appleId, appleIdPassword, teamId },
    };
  }

  return null;
}

// Exported for unit/dry-run testing of the credential-detection branch.
exports.resolveCredentials = resolveCredentials;

exports.default = async function notarizeHook(context) {
  const { electronPlatformName, appOutDir } = context;

  // Only ever touch the macOS .app (electron-builder can't cross-build mac anyway).
  if (electronPlatformName !== 'darwin' || process.platform !== 'darwin') {
    return;
  }

  const resolved = resolveCredentials(process.env);
  if (!resolved) {
    console.log(
      '[notarize] skipping notarization — no credentials. Set ' +
        'APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or ' +
        'APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID to enable it.',
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(
    `[notarize] notarizing ${appName}.app using ${resolved.style} credentials ` +
      '(this can take several minutes)…',
  );

  // Required lazily so non-mac / no-credential builds never load the dependency.
  const { notarize } = require('@electron/notarize');

  await notarize({ appPath, ...resolved.credentials });

  console.log(`[notarize] ${appName}.app notarized and stapled.`);
};
