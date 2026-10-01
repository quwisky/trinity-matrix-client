// Installs the pinned Appium UiAutomator2 driver into the repo-local APPIUM_HOME.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const UIAUTOMATOR2_VERSION = '8.7.0';
const workspaceRoot = join(import.meta.dirname, '..');
const appiumHome = join(workspaceRoot, '.appium');
const env = { ...process.env, APPIUM_HOME: appiumHome };
const appium = join(workspaceRoot, 'node_modules/.bin/appium');

const manifest = join(
  appiumHome,
  'node_modules/appium-uiautomator2-driver/package.json',
);
const installed = existsSync(manifest)
  ? JSON.parse(readFileSync(manifest, 'utf8')).version
  : undefined;
if (installed !== UIAUTOMATOR2_VERSION) {
  if (installed) {
    execFileSync(appium, ['driver', 'uninstall', 'uiautomator2'], {
      env,
      stdio: 'inherit',
    });
  }
  execFileSync(
    appium,
    ['driver', 'install', `uiautomator2@${UIAUTOMATOR2_VERSION}`],
    { env, stdio: 'inherit' },
  );
}
console.log(`uiautomator2 ${UIAUTOMATOR2_VERSION} in ${appiumHome}`);
