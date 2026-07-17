import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, mainWindowRef } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
  mainWindowRef: { current: null as { webContents: unknown } | null },
}));

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, cb: (event: unknown, ...a: unknown[]) => void) => {
      handlers.set(channel, cb);
    },
  },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
}));
vi.mock('./window', () => ({ getMainWindow: () => mainWindowRef.current }));

import {
  ALLOW_CORS_ORIGIN_CHANNEL,
  SET_CORS_ORIGINS_CHANNEL,
  registerCorsIpc,
} from './cors-ipc';
import { allowedCorsOrigins, setAllowedCorsOrigins } from './cors';

registerCorsIpc();

const webContents = { id: 1 };
/** Deliver a payload as our own renderer would. */
const send = (channel: string, payload: unknown): void =>
  handlers.get(channel)?.({ sender: webContents }, payload);
/** Deliver a payload as some OTHER webContents would. */
const sendForeign = (channel: string, payload: unknown): void =>
  handlers.get(channel)?.({ sender: { id: 99 } }, payload);

describe('CORS allowlist IPC', () => {
  beforeEach(() => {
    mainWindowRef.current = { webContents };
    setAllowedCorsOrigins([]);
  });

  it('accepts an origin set from our own renderer', () => {
    send(SET_CORS_ORIGINS_CHANNEL, ['https://hs.example']);
    expect(allowedCorsOrigins()).toEqual(['https://hs.example']);
  });

  it('additively allows a single origin (discovery / login, pre-account)', () => {
    send(SET_CORS_ORIGINS_CHANNEL, ['https://hs.example']);
    send(ALLOW_CORS_ORIGIN_CHANNEL, 'https://probe.example');

    expect(allowedCorsOrigins()).toEqual([
      'https://hs.example',
      'https://probe.example',
    ]);
  });

  // The trust boundary: this channel widens what the renderer may read cross-origin,
  // so a payload from anything but our own window must not touch the allowlist.
  it('ignores both channels from a foreign sender', () => {
    send(SET_CORS_ORIGINS_CHANNEL, ['https://hs.example']);

    sendForeign(SET_CORS_ORIGINS_CHANNEL, ['https://evil.example']);
    sendForeign(ALLOW_CORS_ORIGIN_CHANNEL, 'https://evil.example');

    expect(allowedCorsOrigins()).toEqual(['https://hs.example']);
  });

  it('ignores a malformed payload rather than wiping the list', () => {
    send(SET_CORS_ORIGINS_CHANNEL, ['https://hs.example']);

    send(SET_CORS_ORIGINS_CHANNEL, 'not-an-array');
    send(SET_CORS_ORIGINS_CHANNEL, [1, 2, 3]);
    send(ALLOW_CORS_ORIGIN_CHANNEL, { nope: true });

    expect(allowedCorsOrigins()).toEqual(['https://hs.example']);
  });

  it('ignores everything when there is no main window', () => {
    mainWindowRef.current = null;

    send(SET_CORS_ORIGINS_CHANNEL, ['https://evil.example']);

    expect(allowedCorsOrigins()).toEqual([]);
  });
});
