import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const electronDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const releaseDir = path.join(electronDir, 'release');

function findAddon(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findAddon(candidate);
      if (nested) return nested;
    } else if (
      entry.name === 'native_location.node' &&
      path.basename(path.dirname(candidate)) === 'native-location'
    ) {
      return candidate;
    }
  }
  return undefined;
}

const addonPath = findAddon(releaseDir);
if (!addonPath) {
  throw new Error('Packaged native-location addon was not found outside ASAR.');
}
if (
  process.platform === 'linux' &&
  !existsSync(path.join(releaseDir, 'linux-unpacked', 'trinity'))
) {
  throw new Error('Linux executable/GeoClue DesktopId drifted from "trinity".');
}

const require = createRequire(import.meta.url);
const electronExecutable = require('electron');
const loader = path.join(
  electronDir,
  'scripts',
  'load-native-location-smoke.cjs',
);
const command = process.platform === 'linux' ? 'xvfb-run' : electronExecutable;
const args =
  process.platform === 'linux'
    ? ['-a', electronExecutable, '--no-sandbox', loader, addonPath]
    : [loader, addonPath];
execFileSync(command, args, { stdio: 'inherit' });
console.log(`[native-location-smoke] loaded ${addonPath}`);
