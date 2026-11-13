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
const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('./cors-probe', () => ({ probeMatrixOrigin: probe }));
vi.mock('./window', () => ({ getMainWindow: () => mainWindowRef.current }));

import {
  ALLOW_CORS_ORIGIN_CHANNEL,
  SET_CORS_ORIGINS_CHANNEL,
  registerCorsIpc,
} from './cors-ipc';
import {
  allowedCorsOrigins,
  installMatrixCors,
  setAllowedCorsOrigins,
} from './cors';

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
    probe.mockReset().mockResolvedValue('homeserver');
    setAllowedCorsOrigins([]);
  });

  // The boundary: naming an origin is a request, and main's own probe decides.
  it('cannot make the shim rewrite an origin whose probe fails', async () => {
    type Handler = (
      details: { method: string; url: string },
      callback: (response: object) => void,
    ) => void;
    let handler: Handler | undefined;
    installMatrixCors({
      webRequest: {
        onHeadersReceived: (_: unknown, h: Handler) => (handler = h),
      },
    } as unknown as Electron.Session);
    probe.mockResolvedValue('refused');
    const responses: object[] = [];
    const fetched = (url: string): void =>
      handler?.({ method: 'GET', url }, (r) => responses.push(r));

    send(ALLOW_CORS_ORIGIN_CHANNEL, 'https://10.0.0.5');
    fetched('https://10.0.0.5/admin');
    send(SET_CORS_ORIGINS_CHANNEL, ['https://10.0.0.6']);
    fetched('https://10.0.0.6/admin');
    await new Promise((resolve) => setTimeout(resolve));

    expect(probe).toHaveBeenCalledWith('https://10.0.0.5');
    expect(probe).toHaveBeenCalledWith('https://10.0.0.6');
    expect(responses).toEqual([{}, {}]);
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
