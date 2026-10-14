import { app } from 'electron';
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
 * Give an unpackaged run its channel's app name and user-data folder (e.g. "Trinity
 * Next"), so it keeps its data, single-instance lock and cached OIDC client where a
 * packaged build of that channel would, instead of in the folder named by
 * electron/package.json's productName ("Trinity"). Electron fixes the user-data path from
 * that name before main.js runs, so renaming the app alone does not move it. A
 * `--user-data-dir` switch (the E2E launcher's isolated profile) keeps its folder.
 * Packaged apps already carry both in their package.json. Call before anything reads the
 * user-data folder or takes the single-instance lock.
 */
export function alignDevelopmentName(): void {
  if (app.isPackaged) return;
  const { productName } = appIdentity();
  app.setName(productName);
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    app.setPath('userData', path.join(app.getPath('appData'), productName));
  }
}
