import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const files = new Map<string, string>();
  const notifications: Array<{
    options: { title: string; body: string };
    handlers: Record<string, () => void>;
    shown: boolean;
  }> = [];
  class FakeNotification {
    static isSupported = vi.fn(() => true);
    entry: (typeof notifications)[number];
    constructor(options: { title: string; body: string }) {
      this.entry = { options, handlers: {}, shown: false };
      notifications.push(this.entry);
    }
    on(event: string, handler: () => void) {
      this.entry.handlers[event] = handler;
      return this;
    }
    show() {
      this.entry.shown = true;
    }
  }
  return {
    files,
    notifications,
    FakeNotification,
    fetch: vi.fn(),
    openExternal: vi.fn(),
    showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
    app: {
      getVersion: vi.fn(() => '0.2.0'),
      getPath: vi.fn(() => '/data'),
      isPackaged: true,
    },
  };
});

vi.mock('electron', () => ({
  app: mocks.app,
  dialog: { showMessageBox: mocks.showMessageBox },
  net: { fetch: mocks.fetch },
  Notification: mocks.FakeNotification,
  shell: { openExternal: mocks.openExternal },
}));
vi.mock('node:fs', () => ({
  existsSync: (path: string) => mocks.files.has(path),
  readFileSync: (path: string) => {
    if (!mocks.files.has(path)) throw new Error('ENOENT');
    return mocks.files.get(path);
  },
  writeFileSync: (path: string, data: string) => {
    mocks.files.set(path, data);
  },
}));

import {
  checkForUpdates,
  compareVersions,
  newestRelease,
  parseVersion,
  updateChecksEnabled,
} from './update-check';

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/quwisky/trinity-matrix-client/releases/tag/${tag}`,
  draft: false,
  prerelease: tag.includes('-next.'),
  ...extra,
});
const respond = (body: unknown, ok = true) =>
  mocks.fetch.mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  });

beforeEach(() => {
  mocks.files.clear();
  mocks.notifications.length = 0;
  mocks.fetch.mockReset();
  mocks.openExternal.mockReset();
  mocks.showMessageBox.mockClear();
  mocks.app.getVersion.mockReturnValue('0.2.0');
  mocks.app.isPackaged = true;
  delete process.env.TRINITY_DISABLE_UPDATE_CHECK;
});

describe('version ordering', () => {
  it('parses stable and -next versions, with or without a v', () => {
    expect(parseVersion('v0.2.0')).toEqual({
      major: 0,
      minor: 2,
      patch: 0,
      next: null,
    });
    expect(parseVersion('0.3.0-next.4')).toEqual({
      major: 0,
      minor: 3,
      patch: 0,
      next: 4,
    });
    expect(parseVersion('0.3.0-beta.1')).toBeNull();
  });

  it('orders prereleases before their stable version', () => {
    const order = ['0.2.0', '0.3.0-next.0', '0.3.0-next.1', '0.3.0', '0.10.0'];
    const shuffled = [...order].reverse();
    expect(
      shuffled.sort((a, b) =>
        compareVersions(parseVersion(a)!, parseVersion(b)!),
      ),
    ).toEqual(order);
  });
});

describe('newestRelease', () => {
  it('offers stable users only newer stable releases', () => {
    const releases = [
      release('v0.3.0-next.2'),
      release('v0.2.1'),
      release('v0.2.0'),
    ];
    expect(newestRelease('0.2.0', releases)?.version).toBe('0.2.1');
  });

  it('offers -next users newer prereleases and newer stables', () => {
    const releases = [release('v0.3.0-next.2'), release('v0.3.0')];
    expect(newestRelease('0.3.0-next.1', releases)?.version).toBe('0.3.0');
    expect(
      newestRelease('0.3.0-next.1', [release('v0.3.0-next.2')])?.version,
    ).toBe('0.3.0-next.2');
  });

  it('ignores drafts, older versions, unknown tags and links outside the release page', () => {
    expect(
      newestRelease('0.2.0', [
        release('v0.9.0', { draft: true }),
        release('v0.1.0'),
        release('v1.0.0-beta.1'),
        release('v0.5.0', { html_url: 'https://evil.example/download' }),
      ]),
    ).toBeNull();
  });
});

describe('checkForUpdates', () => {
  it('notifies once per new version and opens its release page on click', async () => {
    respond([release('v0.2.1')]);
    await checkForUpdates({ manual: false });
    await checkForUpdates({ manual: false });
    expect(mocks.notifications).toHaveLength(1);
    expect(mocks.notifications[0].shown).toBe(true);
    expect(mocks.notifications[0].options.title).toBe(
      'Trinity 0.2.1 is available',
    );
    mocks.notifications[0].handlers.click();
    expect(mocks.openExternal).toHaveBeenCalledWith(
      'https://github.com/quwisky/trinity-matrix-client/releases/tag/v0.2.1',
    );
  });

  it('notifies again when an even newer version appears', async () => {
    respond([release('v0.2.1')]);
    await checkForUpdates({ manual: false });
    respond([release('v0.2.2'), release('v0.2.1')]);
    await checkForUpdates({ manual: false });
    expect(mocks.notifications.map((n) => n.options.title)).toEqual([
      'Trinity 0.2.1 is available',
      'Trinity 0.2.2 is available',
    ]);
  });

  it('always notifies on a manual check, and says when the app is up to date', async () => {
    respond([release('v0.2.1')]);
    await checkForUpdates({ manual: false });
    await checkForUpdates({ manual: true });
    expect(mocks.notifications).toHaveLength(2);

    respond([release('v0.2.0')]);
    await checkForUpdates({ manual: true });
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Trinity 0.2.0 is the latest version.',
      }),
    );
  });

  it('stays quiet on automatic failures and explains manual ones', async () => {
    respond({}, false);
    await expect(checkForUpdates({ manual: false })).resolves.toBeUndefined();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    mocks.fetch.mockRejectedValue(new Error('offline'));
    await checkForUpdates({ manual: true });
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Couldn't check for updates." }),
    );
    expect(mocks.notifications).toHaveLength(0);
  });
});

describe('updateChecksEnabled', () => {
  it('runs only in packaged builds and can be switched off', () => {
    expect(updateChecksEnabled()).toBe(true);
    process.env.TRINITY_DISABLE_UPDATE_CHECK = '1';
    expect(updateChecksEnabled()).toBe(false);
    delete process.env.TRINITY_DISABLE_UPDATE_CHECK;
    mocks.app.isPackaged = false;
    expect(updateChecksEnabled()).toBe(false);
  });
});
