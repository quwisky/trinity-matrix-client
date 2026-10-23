import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown;

const { handlers, mainWindowRef, userData, encryption } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  mainWindowRef: { current: null as { webContents: unknown } | null },
  userData: { current: '' },
  encryption: { available: true },
}));

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

vi.mock('electron', () => ({
  app: { getPath: () => userData.current },
  ipcMain: {
    handle: (channel: string, handler: Handler) =>
      handlers.set(channel, handler),
  },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => {
      await tick();
      return encryption.available;
    },
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (plain: string) => {
      await tick();
      return Buffer.from(`enc:${plain}`);
    },
    decryptStringAsync: async (cipher: Buffer) => {
      await tick();
      return { result: cipher.toString().slice(4), shouldReEncrypt: false };
    },
  },
}));
vi.mock('./window', () => ({ getMainWindow: () => mainWindowRef.current }));

import { registerSecureStoreIpc } from './secure-store-ipc';

const contents = { id: 'main' };
const event = { sender: contents };
const call = (channel: string, ...args: unknown[]): unknown =>
  handlers.get(`trinity:secure-store:${channel}`)!(event, ...args);

describe('secure store IPC on the async safeStorage api', () => {
  beforeEach(() => {
    handlers.clear();
    userData.current = fs.mkdtempSync(path.join(os.tmpdir(), 'trinity-ipc-'));
    encryption.available = true;
    mainWindowRef.current = { webContents: contents };
    registerSecureStoreIpc();
  });
  afterEach(() =>
    fs.rmSync(userData.current, { recursive: true, force: true }),
  );

  it('answers a read sent right after a set with the value set', async () => {
    const setting = call('set', 'token', 'sekret');
    const reading = call('read', 'token');
    const getting = call('get', 'token');

    await expect(setting).resolves.toBe(true);
    await expect(reading).resolves.toEqual({
      kind: 'present',
      value: 'sekret',
    });
    await expect(getting).resolves.toBe('sekret');
  });

  it('resolves a delete only once it is on disk', async () => {
    await call('set', 'token', 'sekret');

    await expect(call('delete', 'token')).resolves.toBeUndefined();
    await expect(call('read', 'token')).resolves.toEqual({ kind: 'absent' });
  });

  it('reports unavailable encryption and writes nothing', async () => {
    encryption.available = false;

    await expect(call('available')).resolves.toBe(false);
    await expect(call('set', 'token', 'sekret')).resolves.toBe(false);
    await expect(call('get', 'token')).resolves.toBeNull();
    expect(fs.readdirSync(userData.current)).toEqual([]);
  });

  it('serves nothing to another sender', async () => {
    const stranger = { sender: { id: 'other' } };

    expect(
      await handlers.get('trinity:secure-store:available')!(stranger),
    ).toBe(false);
    expect(
      await handlers.get('trinity:secure-store:set')!(stranger, 'token', 'x'),
    ).toBe(false);
    expect(fs.readdirSync(userData.current)).toEqual([]);
  });
});
