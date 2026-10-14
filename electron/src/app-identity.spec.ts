import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronApp = vi.hoisted(() => ({
  isPackaged: true,
  getVersion: vi.fn(() => '0.5.0'),
  setName: vi.fn(),
  getPath: vi.fn((name: string) => `/home/dev/.config/${name}`),
  setPath: vi.fn(),
  commandLine: { getSwitchValue: vi.fn((_name: string) => '') },
  exit: vi.fn(),
}));
const electronDialog = vi.hoisted(() => ({ showErrorBox: vi.fn() }));
vi.mock('electron', () => ({ app: electronApp, dialog: electronDialog }));

import { CHANNEL_IDENTITY, releaseChannel } from './release-channel';

/** app-identity caches the channel for the process, so each case loads a fresh copy. */
async function load(version: string, isPackaged = true) {
  electronApp.isPackaged = isPackaged;
  electronApp.getVersion.mockReturnValue(version);
  vi.resetModules();
  return import('./app-identity');
}

describe('app identity', () => {
  beforeEach(() => {
    electronApp.setName.mockClear();
    electronApp.setPath.mockClear();
    electronApp.exit.mockClear();
    electronDialog.showErrorBox.mockClear();
    electronApp.commandLine.getSwitchValue.mockReturnValue('');
  });

  it('runs a packaged X.Y.Z-next.N build as Trinity Next', async () => {
    const identity = await load('0.5.0-next.3');
    expect(identity.appChannel()).toBe('next');
    expect(identity.appIdentity()).toEqual(CHANNEL_IDENTITY.next);
    expect(identity.releaseChannelArgument()).toBe(
      '--trinity-release-channel=next',
    );
  });

  it('runs a packaged X.Y.Z build as Trinity', async () => {
    const identity = await load('0.5.0');
    expect(identity.appIdentity()).toEqual(CHANNEL_IDENTITY.stable);
    expect(identity.releaseChannelArgument()).toBe(
      '--trinity-release-channel=stable',
    );
  });

  it('refuses to start under a version outside both channels', async () => {
    const identity = await load('0.5.0-beta.1');
    expect(() => identity.appIdentity()).toThrow(/Unknown release channel/);
  });

  it('stops a packaged app with an unknown version at startup', async () => {
    const identity = await load('0.5.0-beta.1');
    expect(() => identity.alignDevelopmentName()).toThrow(
      /Unknown release channel/,
    );
    expect(electronApp.setName).not.toHaveBeenCalled();
  });

  it("takes an unpackaged run's channel from electron/package.json, not Electron's own version", async () => {
    // `electron dist/main.js`, as the E2E launcher starts the shell, reports Electron's
    // own name and version (44.x), which fits neither channel.
    const identity = await load('44.6.0', false);
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(identity.appChannel()).toBe(releaseChannel(manifest.version));
  });

  it('gives an unpackaged run its channel name, so its data folder matches a packaged build', async () => {
    const identity = await load('44.6.0', false);
    identity.alignDevelopmentName();
    expect(electronApp.setName).toHaveBeenCalledExactlyOnceWith(
      identity.appIdentity().productName,
    );
  });

  it("moves an unpackaged run's user data into its channel's folder, which setName alone does not", async () => {
    // Electron fixes the user-data path from the name it read from package.json before
    // main.js runs, so renaming the app leaves the data (and single-instance lock) behind.
    const identity = await load('44.6.0', false);
    identity.alignDevelopmentName();
    expect(electronApp.setPath).toHaveBeenCalledExactlyOnceWith(
      'userData',
      join('/home/dev/.config/appData', identity.appIdentity().productName),
    );
  });

  it('keeps the profile a --user-data-dir switch chose, as the E2E launcher passes', async () => {
    electronApp.commandLine.getSwitchValue.mockImplementation((name) =>
      name === 'user-data-dir' ? '/tmp/trinity-e2e-abc' : '',
    );
    const identity = await load('44.6.0', false);
    identity.alignDevelopmentName();
    expect(electronApp.setPath).not.toHaveBeenCalled();
    expect(electronApp.setName).toHaveBeenCalledExactlyOnceWith(
      identity.appIdentity().productName,
    );
  });

  it('still moves the user data when --user-data-dir has no value, which Chromium ignores', async () => {
    // `--user-data-dir /x` (space, not `=`) is a valueless switch plus a stray argument.
    electronApp.commandLine.getSwitchValue.mockReturnValue('');
    const identity = await load('44.6.0', false);
    identity.alignDevelopmentName();
    expect(electronApp.commandLine.getSwitchValue).toHaveBeenCalledWith(
      'user-data-dir',
    );
    expect(electronApp.setPath).toHaveBeenCalledExactlyOnceWith(
      'userData',
      join('/home/dev/.config/appData', identity.appIdentity().productName),
    );
  });

  it('leaves a packaged app named by its packaged package.json', async () => {
    const identity = await load('0.5.0-next.3');
    identity.alignDevelopmentName();
    expect(electronApp.setName).not.toHaveBeenCalled();
    expect(electronApp.setPath).not.toHaveBeenCalled();
  });

  it('explains an unknown version in its own error box and exits, leaving no process behind', async () => {
    const identity = await load('0.5.0-beta.1');
    expect(identity.alignDevelopmentNameOrExit()).toBe(false);
    expect(electronDialog.showErrorBox).toHaveBeenCalledExactlyOnceWith(
      'Trinity cannot start',
      expect.stringMatching(/Unknown release channel/),
    );
    expect(electronApp.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('starts a known channel without an error box', async () => {
    const identity = await load('0.5.0-next.3');
    expect(identity.alignDevelopmentNameOrExit()).toBe(true);
    expect(electronDialog.showErrorBox).not.toHaveBeenCalled();
    expect(electronApp.exit).not.toHaveBeenCalled();
  });
});
