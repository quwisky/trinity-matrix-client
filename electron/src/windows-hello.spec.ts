import { describe, expect, it, vi } from 'vitest';
import {
  loadWindowsHello,
  windowsBuild,
  windowsHelloDriver,
} from './windows-hello';

const window = { getNativeWindowHandle: () => Buffer.alloc(8, 1) };

describe('windowsBuild', () => {
  it.each([
    ['10.0.22631', 22631],
    ['10.0.19045', 19045],
    ['garbage', 0],
    ['', 0],
  ])('reads %j as %i', (release, build) => {
    expect(windowsBuild(release)).toBe(build);
  });
});

describe('loadWindowsHello', () => {
  it('loads the packaged addon from resources, and gives up quietly when it cannot', () => {
    const require = vi.fn((_file: string) => ({
      availability: vi.fn(),
      verify: vi.fn(),
    }));
    expect(
      loadWindowsHello({
        packaged: true,
        resourcesPath: 'C:\\app\\resources',
        require,
      }),
    ).not.toBeNull();
    expect(require.mock.calls[0][0]).toMatch(
      /resources[\\/]windows-hello\.node$/,
    );
    expect(
      loadWindowsHello({
        packaged: true,
        resourcesPath: 'C:\\app\\resources',
        require: () => {
          throw new Error('not found');
        },
      }),
    ).toBeNull();
    expect(
      loadWindowsHello({
        packaged: false,
        resourcesPath: '',
        require: () => ({}),
      }),
    ).toBeNull();
  });

  it('loads the development build from electron/build', () => {
    const require = vi.fn((_file: string) => ({
      availability: vi.fn(),
      verify: vi.fn(),
    }));
    loadWindowsHello({ packaged: false, resourcesPath: '', require });
    expect(require.mock.calls[0][0]).toMatch(
      /electron[\\/]build[\\/]windows-hello\.node$/,
    );
  });

  it.each([
    ['nothing', undefined],
    ['a string', 'windows-hello'],
    ['an object without verify', { availability: () => undefined }],
  ])('treats %s as no addon', (_label, loaded) => {
    expect(
      loadWindowsHello({
        packaged: true,
        resourcesPath: 'C:\\app\\resources',
        require: () => loaded,
      }),
    ).toBeNull();
  });
});

describe('windowsHelloDriver', () => {
  const addon = (availability: string, result = 'verified') => ({
    availability: vi.fn(async () => availability),
    verify: vi.fn(async () => result),
  });

  it('offers Hello on Windows 11 when it is set up', async () => {
    await expect(
      windowsHelloDriver(addon('available'), 22631).support(),
    ).resolves.toEqual({
      kind: 'available',
      biometry: 'windows-hello',
    });
  });

  it.each([
    ['not-configured', 22631, 'not-configured'],
    ['disabled-by-policy', 22631, 'disabled-by-policy'],
    ['device-not-present', 22631, 'not-configured'],
    ['device-busy', 22631, 'not-supported'],
    ['unknown', 22631, 'not-supported'],
    ['available', 19045, 'windows-version'],
  ] as const)(
    'falls back to the PIN when %s on build %i',
    async (availability, build, reason) => {
      await expect(
        windowsHelloDriver(addon(availability), build).support(),
      ).resolves.toEqual({
        kind: 'unavailable',
        reason,
      });
    },
  );

  it('does not ask the addon on Windows 10', async () => {
    const hello = addon('available');
    await windowsHelloDriver(hello, 19045).support();
    await expect(
      windowsHelloDriver(hello, 19045).verify(
        'Unlock Trinity',
        window as never,
      ),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'windows-version' });
    expect(hello.availability).not.toHaveBeenCalled();
    expect(hello.verify).not.toHaveBeenCalled();
  });

  it('reports a missing addon, for support and for verify', async () => {
    await expect(windowsHelloDriver(null, 22631).support()).resolves.toEqual({
      kind: 'unavailable',
      reason: 'addon-unavailable',
    });
    await expect(
      windowsHelloDriver(null, 22631).verify('Unlock Trinity', window as never),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'addon-unavailable' });
  });

  it('reads an addon that throws as unavailable', async () => {
    const broken = {
      availability: vi.fn(() => Promise.reject(new Error('COM failure'))),
      verify: vi.fn(() => {
        throw new Error('COM failure');
      }),
    };
    const driver = windowsHelloDriver(broken, 22631);
    await expect(driver.support()).resolves.toEqual({
      kind: 'unavailable',
      reason: 'addon-unavailable',
    });
    await expect(
      driver.verify('Unlock Trinity', window as never),
    ).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'presence-failed' },
    });
  });

  it.each([
    ['verified', { kind: 'verified' }],
    ['cancelled', { kind: 'cancelled' }],
    ['retries-exhausted', { kind: 'locked-out' }],
    ['not-configured', { kind: 'unavailable', reason: 'not-configured' }],
    ['device-not-present', { kind: 'unavailable', reason: 'not-configured' }],
    [
      'disabled-by-policy',
      { kind: 'unavailable', reason: 'disabled-by-policy' },
    ],
    [
      'device-busy',
      { kind: 'rejected', diagnostic: { code: 'presence-failed' } },
    ],
    ['unknown', { kind: 'rejected', diagnostic: { code: 'presence-failed' } }],
  ] as const)('maps the Hello result %s', async (result, outcome) => {
    const hello = addon('available', result);
    await expect(
      windowsHelloDriver(hello, 22631).verify(
        'Unlock Trinity',
        window as never,
      ),
    ).resolves.toEqual(outcome);
  });

  it('passes the window handle so Hello opens in front of Trinity', async () => {
    const hello = addon('available');
    await windowsHelloDriver(hello, 22631).verify(
      'Unlock Trinity',
      window as never,
    );
    expect(hello.verify).toHaveBeenCalledWith(
      Buffer.alloc(8, 1),
      'Unlock Trinity',
    );
  });

  it('needs a window to own the dialog', async () => {
    const hello = addon('available');
    await expect(
      windowsHelloDriver(hello, 22631).verify('Unlock Trinity', null),
    ).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'presence-no-window' },
    });
    expect(hello.verify).not.toHaveBeenCalled();
  });

  describe('one dialog at a time', () => {
    function pending() {
      let settle: (value: string) => void = () => undefined;
      const hello = {
        availability: vi.fn(async () => 'available'),
        verify: vi.fn(
          () =>
            new Promise<string>((resolve) => {
              settle = resolve;
            }),
        ),
      };
      return { hello, settle: (value: string) => settle(value) };
    }

    it('shares the open dialog with a second request for the same reason', async () => {
      const { hello, settle } = pending();
      const driver = windowsHelloDriver(hello, 22631);
      const first = driver.verify('Unlock Trinity', window as never);
      const second = driver.verify('Unlock Trinity', window as never);
      settle('verified');
      await expect(first).resolves.toEqual({ kind: 'verified' });
      await expect(second).resolves.toEqual({ kind: 'verified' });
      expect(hello.verify).toHaveBeenCalledTimes(1);
    });

    it('refuses a request for another reason while a dialog is open', async () => {
      const { hello, settle } = pending();
      const driver = windowsHelloDriver(hello, 22631);
      const first = driver.verify('Unlock Trinity', window as never);
      await expect(
        driver.verify('Turn off app lock', window as never),
      ).resolves.toEqual({
        kind: 'rejected',
        diagnostic: { code: 'presence-busy' },
      });
      settle('cancelled');
      await expect(first).resolves.toEqual({ kind: 'cancelled' });
      expect(hello.verify).toHaveBeenCalledTimes(1);
    });

    it('opens a new dialog once the last one has closed, even after a failure', async () => {
      const hello = {
        availability: vi.fn(async () => 'available'),
        verify: vi
          .fn<(handle: Buffer, message: string) => Promise<string>>()
          .mockRejectedValueOnce(new Error('COM failure'))
          .mockResolvedValueOnce('verified'),
      };
      const driver = windowsHelloDriver(hello, 22631);
      await expect(
        driver.verify('Unlock Trinity', window as never),
      ).resolves.toEqual({
        kind: 'rejected',
        diagnostic: { code: 'presence-failed' },
      });
      await expect(
        driver.verify('Unlock Trinity', window as never),
      ).resolves.toEqual({ kind: 'verified' });
      expect(hello.verify).toHaveBeenCalledTimes(2);
    });
  });
});
