// Installs pinned Appium drivers into the repo-local APPIUM_HOME.
// Usage: node scripts/setup-appium.mjs [uiautomator2|xcuitest]... (default: uiautomator2)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DRIVERS = {
  uiautomator2: { version: '8.7.0', packageName: 'appium-uiautomator2-driver' },
  xcuitest: { version: '12.14.0', packageName: 'appium-xcuitest-driver' },
};
const workspaceRoot = join(import.meta.dirname, '..');
const appiumHome = join(workspaceRoot, '.appium');
const env = { ...process.env, APPIUM_HOME: appiumHome };
const appium = join(workspaceRoot, 'node_modules/.bin/appium');

const requested = process.argv.slice(2);
for (const name of requested.length > 0 ? requested : ['uiautomator2']) {
  const driver = DRIVERS[name];
  if (!driver) {
    throw new Error(
      `Unknown Appium driver ${name}; expected ${Object.keys(DRIVERS).join(' or ')}`,
    );
  }
  const manifest = join(
    appiumHome,
    'node_modules',
    driver.packageName,
    'package.json',
  );
  const installed = existsSync(manifest)
    ? JSON.parse(readFileSync(manifest, 'utf8')).version
    : undefined;
  if (installed !== driver.version) {
    if (installed) {
      execFileSync(appium, ['driver', 'uninstall', name], {
        env,
        stdio: 'inherit',
      });
    }
    execFileSync(appium, ['driver', 'install', `${name}@${driver.version}`], {
      env,
      stdio: 'inherit',
    });
  }
  console.log(`${name} ${driver.version} in ${appiumHome}`);
}
