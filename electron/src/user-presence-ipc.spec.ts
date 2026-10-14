import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, mainWindowRef } = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: { sender: unknown }, request?: unknown) => unknown
  >(),
  mainWindowRef: { current: null as { webContents: unknown } | null },
}));

vi.mock('electron', () => ({
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

import {
  USER_PRESENCE_SUPPORT_CHANNEL,
  USER_PRESENCE_VERIFY_CHANNEL,
  registerUserPresenceIpc,
} from './user-presence-ipc';

const contents = { id: 'main' };

describe('user presence IPC', () => {
  const driver = {
    support: vi.fn(async () => ({
      kind: 'available' as const,
      biometry: 'touch-id' as const,
    })),
    verify: vi.fn(async () => ({ kind: 'verified' as const })),
  };

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    mainWindowRef.current = { webContents: contents };
    registerUserPresenceIpc(driver);
  });

  it('answers only the main window', async () => {
    const support = handlers.get(USER_PRESENCE_SUPPORT_CHANNEL)!;
    await expect(support({ sender: { id: 'other' } })).resolves.toEqual({
      system: { kind: 'unavailable', reason: 'not-supported' },
      pin: { kind: 'unavailable', reason: 'not-supported' },
    });
    expect(driver.support).not.toHaveBeenCalled();
    await expect(support({ sender: contents })).resolves.toEqual({
      system: { kind: 'available', biometry: 'touch-id' },
      pin: { kind: 'unavailable', reason: 'not-supported' },
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
    expect(answer).toEqual({
      system: { kind: 'unavailable', reason: 'not-supported' },
      pin: { kind: 'unavailable', reason: 'not-supported' },
    });
    expect(JSON.stringify(answer).includes('LAContext')).toBe(false);
  });
});
