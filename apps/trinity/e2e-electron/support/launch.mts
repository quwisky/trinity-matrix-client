import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication } from 'playwright';

// apps/trinity/e2e-electron/support → repo root.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
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

/** Launch the built Trinity desktop app for an e2e run. */
export function launchApp(): Promise<ElectronApplication> {
  return electron.launch({
    args: [
      mainEntry,
      // Required when running as root / in a container (CI); harmless on a desktop.
      // This is the Chromium zygote sandbox flag, NOT the app's webPreferences
      // sandbox (which stays true) — it only affects the test launch.
      '--no-sandbox',
    ],
    executablePath: electronExecutable(),
  });
}
