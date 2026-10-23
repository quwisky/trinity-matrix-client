import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, mainWindowRef, osRelease } = vi.hoisted(() => ({
  osRelease: { current: '10.0.22631' },
  handlers: new Map<
    string,
    (event: { sender: unknown }, request?: unknown) => unknown
  >(),
  mainWindowRef: { current: null as { webContents: unknown } | null },
}));

vi.mock('electron', () => ({
  // Only the default verifier reads these; every test passes its own.
  app: { getPath: () => '/profile', isPackaged: true },
  safeStorage: {},
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: { sender: unknown }, request?: unknown) => unknown,
    ) => handlers.set(channel, handler),
  },
  systemPreferences: {
    canPromptTouchID: () => false,
    promptTouchID: () => Promise.resolve(),
  },
}));
vi.mock('./window', () => ({ getMainWindow: () => mainWindowRef.current }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  release: () => osRelease.current,
}));

import { PinVerifier, type PinFileIo } from './app-lock-pin-store';
import {
  USER_PRESENCE_CLEAR_PIN_CHANNEL,
  USER_PRESENCE_SET_PIN_CHANNEL,
  USER_PRESENCE_SUPPORT_CHANNEL,
  USER_PRESENCE_VERIFY_CHANNEL,
  USER_PRESENCE_VERIFY_PIN_CHANNEL,
  defaultPresenceDriver,
  registerUserPresenceIpc,
} from './user-presence-ipc';
import { NO_SYSTEM_PRESENCE } from './user-presence';
import { loadWindowsHello, windowsHelloDriver } from './windows-hello';

const contents = { id: 'main' };

describe('user presence IPC', () => {
  const driver = {
    support: vi.fn(async () => ({
      kind: 'available' as const,
      biometry: 'touch-id' as const,
    })),
    verify: vi.fn(async () => ({ kind: 'verified' as const })),
  };
  const pins = {
    status: vi.fn(async () => ({
      kind: 'ready' as const,
      set: true,
      nextAttemptAt: null,
    })),
    set: vi.fn(async () => 'completed' as const),
    verify: vi.fn(async () => ({ kind: 'verified' as const })),
    clear: vi.fn(() => 'completed' as const),
  };

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    mainWindowRef.current = { webContents: contents };
    registerUserPresenceIpc(driver, pins as never);
  });

  it('answers only the main window', async () => {
    const support = handlers.get(USER_PRESENCE_SUPPORT_CHANNEL)!;
    await expect(support({ sender: { id: 'other' } })).resolves.toEqual({
      system: { kind: 'unavailable', reason: 'not-supported' },
      pin: { kind: 'unavailable', reason: 'not-supported' },
    });
    expect(driver.support).not.toHaveBeenCalled();
    expect(pins.status).not.toHaveBeenCalled();
    await expect(support({ sender: contents })).resolves.toEqual({
      system: { kind: 'available', biometry: 'touch-id' },
      pin: { kind: 'available', set: true, nextAttemptAt: null },
    });
    await expect(
      handlers.get(USER_PRESENCE_VERIFY_CHANNEL)!(
        { sender: { id: 'other' } },
        { reason: 'Unlock Trinity' },
      ),
    ).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'sender-rejected' },
    });
    expect(driver.verify).not.toHaveBeenCalled();
  });

  it('refuses a malformed reason without prompting', async () => {
    const verify = handlers.get(USER_PRESENCE_VERIFY_CHANNEL)!;
    for (const raw of [undefined, 'Unlock', { reason: '' }, { reason: 7 }]) {
      await expect(verify({ sender: contents }, raw)).resolves.toEqual({
        kind: 'rejected',
        diagnostic: { code: 'invalid-presence-reason' },
      });
    }
    expect(driver.verify).not.toHaveBeenCalled();
  });

  it('prompts with the validated reason', async () => {
    await expect(
      handlers.get(USER_PRESENCE_VERIFY_CHANNEL)!(
        { sender: contents },
        { reason: 'Unlock Trinity' },
      ),
    ).resolves.toEqual({ kind: 'verified' });
    expect(driver.verify).toHaveBeenCalledWith('Unlock Trinity', {
      webContents: contents,
    });
  });

  it('turns a driver failure into a stable code', async () => {
    driver.verify.mockRejectedValueOnce(new Error('LAContext detail'));
    const outcome = await handlers.get(USER_PRESENCE_VERIFY_CHANNEL)!(
      { sender: contents },
      { reason: 'Unlock Trinity' },
    );
    expect(outcome).toEqual({
      kind: 'rejected',
      diagnostic: { code: 'presence-failed' },
    });
  });

  it('answers support without the error text when the driver fails', async () => {
    driver.support.mockRejectedValueOnce(new Error('LAContext detail'));
    const answer = await handlers.get(USER_PRESENCE_SUPPORT_CHANNEL)!({
      sender: contents,
    });
    // The PIN does not need the system prompt (decision 15), so it is still reported.
    expect(answer).toEqual({
      system: { kind: 'unavailable', reason: 'not-supported' },
      pin: { kind: 'available', set: true, nextAttemptAt: null },
    });
    expect(JSON.stringify(answer).includes('LAContext')).toBe(false);
  });

  it('forwards PIN commands from the main window only, as plain outcomes', async () => {
    const setPin = handlers.get(USER_PRESENCE_SET_PIN_CHANNEL)!;
    const verifyPin = handlers.get(USER_PRESENCE_VERIFY_PIN_CHANNEL)!;
    const clearPin = handlers.get(USER_PRESENCE_CLEAR_PIN_CHANNEL)!;
    await expect(
      setPin({ sender: { id: 'other' } }, { pin: '482913' }),
    ).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'sender-rejected' },
    });
    expect(pins.set).not.toHaveBeenCalled();
    await expect(
      setPin({ sender: contents }, { pin: '482913' }),
    ).resolves.toEqual({
      kind: 'completed',
    });
    expect(pins.set).toHaveBeenCalledWith('482913');
    await expect(
      verifyPin({ sender: contents }, { pin: '482913' }),
    ).resolves.toEqual({
      kind: 'verified',
    });
    expect(pins.verify).toHaveBeenCalledWith('482913');
    await expect(clearPin({ sender: contents })).resolves.toEqual({
      kind: 'completed',
    });
    pins.set.mockResolvedValueOnce('invalid' as never);
    await expect(setPin({ sender: contents }, { pin: 'x' })).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'pin-invalid' },
    });
  });

  it('refuses PIN checks and the clear from any other sender', async () => {
    const other = { sender: { id: 'other' } };
    await expect(
      handlers.get(USER_PRESENCE_VERIFY_PIN_CHANNEL)!(other, { pin: '482913' }),
    ).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'sender-rejected' },
    });
    await expect(
      handlers.get(USER_PRESENCE_CLEAR_PIN_CHANNEL)!(other),
    ).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'sender-rejected' },
    });
    mainWindowRef.current = null;
    await expect(
      handlers.get(USER_PRESENCE_VERIFY_PIN_CHANNEL)!(
        { sender: contents },
        { pin: '482913' },
      ),
    ).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'sender-rejected' },
    });
    expect(pins.verify).not.toHaveBeenCalled();
    expect(pins.clear).not.toHaveBeenCalled();
  });

  it('passes only the pin field on, and nothing for a payload without one', async () => {
    const verifyPin = handlers.get(USER_PRESENCE_VERIFY_PIN_CHANNEL)!;
    for (const raw of [undefined, null, '482913', 482913, {}]) {
      await verifyPin({ sender: contents }, raw);
    }
    await verifyPin({ sender: contents }, { pin: '482913', extra: 'x' });
    expect(pins.verify.mock.calls).toEqual([
      [undefined],
      [undefined],
      [undefined],
      [undefined],
      [undefined],
      ['482913'],
    ]);
  });

  it('passes waits and failures through', async () => {
    pins.verify.mockResolvedValueOnce({
      kind: 'delayed',
      nextAttemptAt: 30_000,
    } as never);
    await expect(
      handlers.get(USER_PRESENCE_VERIFY_PIN_CHANNEL)!(
        { sender: contents },
        { pin: '482913' },
      ),
    ).resolves.toEqual({ kind: 'delayed', nextAttemptAt: 30_000 });
  });

  it('reports a PIN it cannot read as secure storage unavailable', async () => {
    pins.status.mockResolvedValueOnce({ kind: 'unavailable' } as never);
    await expect(
      handlers.get(USER_PRESENCE_SUPPORT_CHANNEL)!({ sender: contents }),
    ).resolves.toEqual({
      system: { kind: 'available', biometry: 'touch-id' },
      pin: { kind: 'unavailable', reason: 'secure-storage-unavailable' },
    });
  });

  it('reports a host with no PIN store as not supported', async () => {
    pins.status.mockResolvedValueOnce({ kind: 'not-supported' } as never);
    await expect(
      handlers.get(USER_PRESENCE_SUPPORT_CHANNEL)!({ sender: contents }),
    ).resolves.toEqual({
      system: { kind: 'available', biometry: 'touch-id' },
      pin: { kind: 'unavailable', reason: 'not-supported' },
    });
  });

  it('turns a verifier that cannot store or clear into plain outcomes', async () => {
    pins.set.mockResolvedValueOnce('unavailable' as never);
    pins.clear.mockReturnValueOnce('unavailable' as never);
    await expect(
      handlers.get(USER_PRESENCE_SET_PIN_CHANNEL)!(
        { sender: contents },
        { pin: '482913' },
      ),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'not-supported' });
    // A PIN that may still be on disk must fail the full reset, never read as "none".
    await expect(
      handlers.get(USER_PRESENCE_CLEAR_PIN_CHANNEL)!({ sender: contents }),
    ).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'pin-clear-failed' },
    });
  });

  it('never lets a verifier error cross IPC as text', async () => {
    const boom = new Error('pin 482913 detail');
    pins.set.mockRejectedValueOnce(boom);
    pins.verify.mockRejectedValueOnce(boom);
    pins.clear.mockImplementationOnce(() => {
      throw boom;
    });
    pins.status.mockRejectedValueOnce(boom);
    const answers = [
      await handlers.get(USER_PRESENCE_SET_PIN_CHANNEL)!(
        { sender: contents },
        { pin: '482913' },
      ),
      await handlers.get(USER_PRESENCE_VERIFY_PIN_CHANNEL)!(
        { sender: contents },
        { pin: '482913' },
      ),
      await handlers.get(USER_PRESENCE_CLEAR_PIN_CHANNEL)!({
        sender: contents,
      }),
      await handlers.get(USER_PRESENCE_SUPPORT_CHANNEL)!({ sender: contents }),
    ];
    expect(answers).toEqual([
      { kind: 'unavailable', reason: 'not-supported' },
      { kind: 'unavailable' },
      { kind: 'rejected', diagnostic: { code: 'pin-clear-failed' } },
      {
        system: { kind: 'available', biometry: 'touch-id' },
        pin: { kind: 'unavailable', reason: 'secure-storage-unavailable' },
      },
    ]);
    expect(JSON.stringify(answers).includes('482913')).toBe(false);
  });
});

describe('user presence IPC with the real verifier', () => {
  const files = new Map<string, string>();
  const io: PinFileIo = {
    read: (path) => files.get(path) ?? null,
    write: (path, data) => void files.set(path, data),
    remove: (path) => void files.delete(path),
  };
  let encryption = true;
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => encryption,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (plain: string) =>
      Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decryptStringAsync: async (cipher: Buffer) => ({
      result: Buffer.from(cipher.toString().slice(4), 'base64').toString(),
      shouldReEncrypt: false,
    }),
  };

  beforeEach(() => {
    handlers.clear();
    files.clear();
    encryption = true;
    mainWindowRef.current = { webContents: contents };
    registerUserPresenceIpc(
      {
        support: async () => ({ kind: 'unavailable', reason: 'not-supported' }),
        verify: async () => ({ kind: 'unavailable', reason: 'not-supported' }),
      },
      new PinVerifier({
        safeStorage: safeStorage as never,
        file: '/profile/app-lock.bin',
        io,
        params: { N: 1024, r: 8, p: 1 },
      }),
    );
  });

  it('holds IPC to 4 to 16 ASCII digits and never echoes a PIN', async () => {
    const event = { sender: contents };
    const call = (channel: string, pin?: unknown) =>
      handlers.get(channel)!(event, pin === undefined ? undefined : { pin });
    const answers = [
      await call(USER_PRESENCE_SET_PIN_CHANNEL, '123'),
      await call(USER_PRESENCE_SET_PIN_CHANNEL, '12345678901234567'),
      await call(USER_PRESENCE_SET_PIN_CHANNEL, '\u0664\u0668\u0662\u0669'),
      await call(USER_PRESENCE_SET_PIN_CHANNEL, '4829'),
      await call(USER_PRESENCE_VERIFY_PIN_CHANNEL, '12345678901234567'),
      await call(USER_PRESENCE_VERIFY_PIN_CHANNEL, '4821'),
      await call(USER_PRESENCE_VERIFY_PIN_CHANNEL, '4829'),
      await call(USER_PRESENCE_SUPPORT_CHANNEL),
    ];
    const invalid = { kind: 'rejected', diagnostic: { code: 'pin-invalid' } };
    expect(answers).toEqual([
      invalid,
      invalid,
      invalid,
      { kind: 'completed' },
      { kind: 'invalid' },
      { kind: 'failed', nextAttemptAt: null },
      { kind: 'verified' },
      {
        system: { kind: 'unavailable', reason: 'not-supported' },
        pin: { kind: 'available', set: true, nextAttemptAt: null },
      },
    ]);
    const text = JSON.stringify(answers);
    expect(text.includes('4829')).toBe(false);
    expect(text.includes('4821')).toBe(false);
  });

  it('without usable encryption, reports no PIN store unless a PIN file exists', async () => {
    const event = { sender: contents };
    const support = handlers.get(USER_PRESENCE_SUPPORT_CHANNEL)!;
    const setPin = handlers.get(USER_PRESENCE_SET_PIN_CHANNEL)!;
    encryption = false;
    await expect(support(event)).resolves.toEqual({
      system: { kind: 'unavailable', reason: 'not-supported' },
      pin: { kind: 'unavailable', reason: 'not-supported' },
    });
    await expect(setPin(event, { pin: '4829' })).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    expect(files.size).toBe(0);
    encryption = true;
    await expect(setPin(event, { pin: '4829' })).resolves.toEqual({
      kind: 'completed',
    });
    encryption = false;
    await expect(support(event)).resolves.toEqual({
      system: { kind: 'unavailable', reason: 'not-supported' },
      pin: { kind: 'unavailable', reason: 'secure-storage-unavailable' },
    });
  });
});

describe('user presence IPC on Windows without a loadable Hello addon', () => {
  const files = new Map<string, string>();
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptStringAsync: async (plain: string) =>
      Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decryptStringAsync: async (cipher: Buffer) => ({
      result: Buffer.from(cipher.toString().slice(4), 'base64').toString(),
      shouldReEncrypt: false,
    }),
  };

  beforeEach(() => {
    handlers.clear();
    files.clear();
    mainWindowRef.current = {
      webContents: contents,
      getNativeWindowHandle: () => Buffer.alloc(8, 1),
    } as never;
    const addon = loadWindowsHello({
      packaged: true,
      resourcesPath: 'C:\\app\\resources',
      require: () => {
        throw new Error('The specified module could not be found.');
      },
    });
    registerUserPresenceIpc(
      windowsHelloDriver(addon, 22631),
      new PinVerifier({
        safeStorage: safeStorage as never,
        file: 'C:\\profile\\app-lock.bin',
        io: {
          read: (path) => files.get(path) ?? null,
          write: (path, data) => void files.set(path, data),
          remove: (path) => void files.delete(path),
        },
        params: { N: 1024, r: 8, p: 1 },
      }),
    );
  });

  it('reports no Windows Hello and keeps the Trinity PIN working', async () => {
    const event = { sender: contents };
    const support = handlers.get(USER_PRESENCE_SUPPORT_CHANNEL)!;
    await expect(support(event)).resolves.toEqual({
      system: { kind: 'unavailable', reason: 'addon-unavailable' },
      pin: { kind: 'available', set: false, nextAttemptAt: null },
    });
    await expect(
      handlers.get(USER_PRESENCE_VERIFY_CHANNEL)!(event, {
        reason: 'Unlock Trinity',
      }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'addon-unavailable' });
    await expect(
      handlers.get(USER_PRESENCE_SET_PIN_CHANNEL)!(event, { pin: '4829' }),
    ).resolves.toEqual({ kind: 'completed' });
    await expect(
      handlers.get(USER_PRESENCE_VERIFY_PIN_CHANNEL)!(event, { pin: '4829' }),
    ).resolves.toEqual({ kind: 'verified' });
    await expect(support(event)).resolves.toEqual({
      system: { kind: 'unavailable', reason: 'addon-unavailable' },
      pin: { kind: 'available', set: true, nextAttemptAt: null },
    });
  });
});

describe('defaultPresenceDriver', () => {
  it('has no system prompt on linux', () => {
    expect(defaultPresenceDriver('linux')).toBe(NO_SYSTEM_PRESENCE);
  });

  // Under Vitest `process.resourcesPath` is undefined, so building the addon's path throws
  // inside the loader, as any load failure does: Windows 11 reports the addon missing and
  // stays on the PIN.
  it('reads Windows 11 whose addon cannot be loaded as no Windows Hello', async () => {
    osRelease.current = '10.0.22631';
    await expect(defaultPresenceDriver('win32').support()).resolves.toEqual({
      kind: 'unavailable',
      reason: 'addon-unavailable',
    });
  });

  it('reads Windows 10 as windows-version', async () => {
    osRelease.current = '10.0.19045';
    await expect(defaultPresenceDriver('win32').support()).resolves.toEqual({
      kind: 'unavailable',
      reason: 'windows-version',
    });
  });
});
