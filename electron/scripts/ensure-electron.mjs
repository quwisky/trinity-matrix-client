// Makes sure node_modules/electron/dist holds a runnable Electron binary.
//
// Electron dropped its postinstall script in v42: `pnpm install` downloads nothing, and
// the package instead fetches the binary lazily, the first time `require('electron')`
// resolves a path. That is too late for us — `sign:dev` codesigns dist/Electron.app
// before anything requires the package, so on macOS the first `pnpm electron:start`
// after a clone would fail on a missing app. `pnpm electron:install` therefore calls
// this, which drives the package's own installer (idempotent: it self-skips when the
// matching version is already unpacked).
//
// Zero dependencies, so it can run before anything else is built.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const electronRoot = dirname(here); // electron/
const packageDir = join(electronRoot, 'node_modules', 'electron');
const installer = join(packageDir, 'install.js');

if (!existsSync(installer)) {
  console.error(
    `[ensure-electron] The electron package is not installed at ${packageDir}\n` +
      `[ensure-electron] Run "pnpm -C electron install" first.`,
  );
  process.exit(1);
}

const { version } = JSON.parse(
  readFileSync(join(packageDir, 'package.json'), 'utf8'),
);

/**
 * Mirrors the package's own install check: dist/ unpacked, stamped with this exact
 * version, and the executable path.txt names actually present.
 *
 * @returns the path to the Electron executable, or null if it is missing/stale
 */
function installedBinary() {
  const distDir = join(packageDir, 'dist');
  const versionStamp = join(distDir, 'version');
  const pathFile = join(packageDir, 'path.txt');
  if (!existsSync(versionStamp) || !existsSync(pathFile)) {
    return null;
  }
  if (readFileSync(versionStamp, 'utf8').trim().replace(/^v/, '') !== version) {
    return null;
  }
  const binary = join(distDir, readFileSync(pathFile, 'utf8').trim());
  return existsSync(binary) ? binary : null;
}

const alreadyInstalled = installedBinary();
if (alreadyInstalled) {
  console.log(
    `[ensure-electron] Electron ${version} already installed: ${alreadyInstalled}`,
  );
  process.exit(0);
}

console.log(
  `[ensure-electron] Fetching the Electron ${version} binary ` +
    `(~119 MB zipped; reused from the local Electron cache when already downloaded)…`,
);
try {
  execFileSync(process.execPath, [installer], { stdio: 'inherit' });
} catch {
  console.error(
    `[ensure-electron] The Electron installer failed — see the output above.`,
  );
  process.exit(1);
}

const binary = installedBinary();
if (!binary) {
  console.error(
    `[ensure-electron] The installer exited cleanly but left no Electron ${version} ` +
      `binary under ${join(packageDir, 'dist')}`,
  );
  process.exit(1);
}
console.log(`[ensure-electron] Electron ${version} ready: ${binary}`);
