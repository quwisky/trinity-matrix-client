import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication } from 'playwright';

// e2e/electron/support → repo root.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const electronDir = path.join(repoRoot, 'electron');
const mainEntry = path.join(electronDir, 'dist', 'main.js');

/**
 * Resolve the Electron executable. The `electron` package lives in `electron/`
 * (its own package.json), not the workspace root, and when required it returns the
 * path to the downloaded binary — so resolve it from there.
 */
function electronExecutable(): string {
  const requireFromElectron = createRequire(
    path.join(electronDir, 'package.json'),
  );
  return requireFromElectron('electron') as unknown as string;
}

/** Allocate a profile path a journey can retain across Electron process restarts. */
export function createElectronProfile(): string {
  return mkdtempSync(path.join(tmpdir(), 'trinity-e2e-'));
}

/** Launch the built Trinity desktop app with an isolated or explicitly retained profile. */
export function launchApp(
  userDataDir = createElectronProfile(),
): Promise<ElectronApplication> {
  // The default is a fresh profile so the app starts unauthenticated. A journey may
  // pass one explicitly when it needs to prove behavior across a process restart.
  return electron.launch({
    args: [
      // Required when running as root / in a container (CI); harmless on a desktop.
      // This is the Chromium zygote sandbox flag, NOT the app's webPreferences
      // sandbox (which stays true) — it only affects the test launch.
      '--no-sandbox',
      // Electron E2E uses loopback servers as deterministic remote origins. Disable
      // Chromium's separate local-network permission gate in this test process so
      // those requests reach the app's production CORS interceptor under test.
      '--disable-features=LocalNetworkAccessChecks',
      // Local HTTPS fixtures use a committed test-only certificate. Ignoring its trust
      // status does not disable webSecurity or the CORS checks under test.
      '--ignore-certificate-errors',
      `--user-data-dir=${userDataDir}`,
      mainEntry,
    ],
    executablePath: electronExecutable(),
  });
}
