// electron-builder `afterPack` hook: harden the packaged Electron binary's fuses.
//
// Without this, the shipped binary keeps Electron's default fuses, so a local
// unprivileged process can re-launch the SIGNED Trinity binary as Node
// (ELECTRON_RUN_AS_NODE=1 or NODE_OPTIONS=--require evil.js, or --inspect) and run
// arbitrary code inside the trusted main process — the one holding OS-keychain access
// to the safeStorage secret map (Matrix tokens + cross-signing keys). Flipping these
// fuses off closes that injection vector, and the asar fuses close the sibling route of
// swapping the application code itself rather than the runtime flags.
//
// Runs BEFORE code-signing, so on macOS the ad-hoc signature is reset here and the
// real Developer ID signing step re-signs the mutated binary.
const path = require('node:path');
const fs = require('node:fs');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

/**
 * The fuse set applied to the packaged binary. Split out because flipping fuses for
 * real needs a packaged Electron binary, which only exists during a `package` run —
 * the spec asserts the set here instead.
 *
 * @param {string} electronPlatformName
 */
function fuseOptions(electronPlatformName) {
  return {
    version: FuseVersion.V1,
    // Re-apply an ad-hoc signature on macOS (fuse mutation invalidates it); the
    // subsequent electron-builder signing step replaces it with the real identity.
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    // Refuse an unpacked `app/` dropped next to app.asar — otherwise a process that
    // can write to the install dir reaches the same privileged main process the three
    // fuses above deny, and Windows/Linux ship unsigned today.
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // Verify the asar against the header electron-builder embeds (Info.plist on
    // macOS, the PE resource on Windows). Linux has no such header, so asking for
    // validation there would only make the app refuse to start.
    ...(electronPlatformName === 'darwin' || electronPlatformName === 'win32'
      ? { [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true }
      : {}),
  };
}

/** @param {import('electron-builder').AfterPackContext} context */
module.exports = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const app = packager.appInfo.productFilename;
  const binary = {
    darwin: path.join(appOutDir, `${app}.app`, 'Contents', 'MacOS', app),
    win32: path.join(appOutDir, `${app}.exe`),
    linux: path.join(appOutDir, packager.executableName || app.toLowerCase()),
  }[electronPlatformName];

  if (!binary || !fs.existsSync(binary)) {
    // Fail loudly rather than ship an un-hardened binary silently.
    throw new Error(
      `afterPack: could not find the Electron binary to harden: ${binary}`,
    );
  }

  await flipFuses(binary, fuseOptions(electronPlatformName));
};

module.exports.fuseOptions = fuseOptions;
