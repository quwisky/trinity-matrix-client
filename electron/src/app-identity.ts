import { app, dialog } from 'electron';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  CHANNEL_IDENTITY,
  releaseChannel,
  type ChannelIdentity,
  type ReleaseChannel,
} from './release-channel';

/** window.ts passes this to preload; preload.ts reads it by string value. */
export const RELEASE_CHANNEL_ARGUMENT = '--trinity-release-channel=';

let channel: ReleaseChannel | undefined;

/**
 * The version that decides this run's channel. A packaged app reports its own. An
 * unpackaged run reads electron/package.json, because `electron dist/main.js` (the E2E
 * launcher) reports Electron's own version instead.
 */
function runningVersion(): string {
  if (app.isPackaged) return app.getVersion();
  const manifest = JSON.parse(
    readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  ) as { readonly version?: unknown };
  if (typeof manifest.version !== 'string') {
    throw new Error('electron/package.json has no version.');
  }
  return manifest.version;
}

/** This process's release channel. An unknown version shape throws: the app does not start. */
export function appChannel(): ReleaseChannel {
  channel ??= releaseChannel(runningVersion());
  return channel;
}

/** App ID, product name, URL scheme and device name of this process's channel. */
export function appIdentity(): ChannelIdentity {
  return CHANNEL_IDENTITY[appChannel()];
}

/** The preload argument that tells the renderer which app it runs in. */
export function releaseChannelArgument(): string {
  return `${RELEASE_CHANNEL_ARGUMENT}${appChannel()}`;
}

/**
 * Resolve this run's channel, so an unknown version shape stops startup, and give an
 * unpackaged run its channel's app name and user-data folder. Data, single-instance lock
 * and cached OIDC client then sit where a packaged build of that channel keeps them, not
 * in the folder Electron picked before main.js ran (productName for `electron .`, Electron's
 * own name for `electron dist/main.js`; renaming the app alone does not move it). A
 * `--user-data-dir=<path>` switch (the E2E isolated profile) keeps its folder. Packaged
 * apps already carry both. Call before anything reads the user-data folder or takes the
 * single-instance lock.
 */
export function alignDevelopmentName(): void {
  const { productName } = appIdentity();
  if (app.isPackaged) return;
  app.setName(productName);
  // Chromium takes the profile only from `--user-data-dir=<path>`; a bare switch has an
  // empty value and leaves the default folder in place, so it is moved like no switch.
  if (app.commandLine.getSwitchValue('user-data-dir') === '') {
    app.setPath('userData', path.join(app.getPath('appData'), productName));
  }
}

/**
 * alignDevelopmentName(), or an error box and exit code 1 when the version names no known
 * channel. An uncaught throw would show Electron's generic dialog and leave a windowless
 * process behind on every relaunch (the single-instance lock is not taken yet). The title
 * names no channel, as that is what is unknown. Returns whether startup may continue.
 * dialog.showErrorBox is safe before `ready`.
 */
export function alignDevelopmentNameOrExit(): boolean {
  try {
    alignDevelopmentName();
    return true;
  } catch (error) {
    dialog.showErrorBox(
      'Trinity cannot start',
      error instanceof Error ? error.message : String(error),
    );
    app.exit(1);
    return false;
  }
}
