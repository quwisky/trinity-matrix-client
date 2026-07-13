import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fakes for the native surface the handler touches. vi.hoisted so they exist when
// the mock factories run. `mainWindowRef` is a mutable holder the getMainWindow
// mock reads, letting each test swap in a fake window (or null).
const { handlers, netFetch, mainWindowRef } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  netFetch: vi.fn(),
  mainWindowRef: {
    current: null as { webContents: object } | null,
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => unknown,
    ) => {
      handlers.set(channel, handler);
    },
  },
  net: { fetch: netFetch },
}));

vi.mock('./window', () => ({
  getMainWindow: () => mainWindowRef.current,
}));

import {
  APPROX_LOCATION_CHANNEL,
  registerGeolocationIpc,
} from './geolocation-ipc';

registerGeolocationIpc();
const handler = handlers.get(APPROX_LOCATION_CHANNEL);

/** Invoke the captured IPC handler as if from `sender`. */
function invoke(sender: unknown): Promise<unknown> {
  return Promise.resolve(handler?.({ sender }));
}

/** A fake fetch Response carrying `body` (or a non-ok status). */
function jsonResponse(body: unknown, ok = true): unknown {
  return { ok, json: () => Promise.resolve(body) };
}

describe('registerGeolocationIpc', () => {
  beforeEach(() => {
    // Default: our real main window is the caller, lookup succeeds.
    mainWindowRef.current = { webContents: {} };
    netFetch.mockResolvedValue(
      jsonResponse({ latitude: 48.8584, longitude: 2.2945 }),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    mainWindowRef.current = null;
  });

  it('returns the looked-up coordinates for the main window renderer', async () => {
    await expect(invoke(mainWindowRef.current!.webContents)).resolves.toEqual({
      lat: 48.8584,
      lng: 2.2945,
    });
    expect(netFetch).toHaveBeenCalledTimes(1);
  });

  it('ignores a request from any other sender (no fetch)', async () => {
    await expect(invoke({})).resolves.toBeNull();
    expect(netFetch).not.toHaveBeenCalled();
  });

  it('returns null when there is no main window', async () => {
    const sender = mainWindowRef.current!.webContents;
    mainWindowRef.current = null;

    await expect(invoke(sender)).resolves.toBeNull();
    expect(netFetch).not.toHaveBeenCalled();
  });

  it('returns null on a non-ok response even when the body carries coordinates', async () => {
    // Valid coords + ok:false isolates the status guard: without it, the handler
    // would return the point instead of null.
    netFetch.mockResolvedValue(
      jsonResponse({ latitude: 48.8584, longitude: 2.2945 }, false),
    );

    await expect(
      invoke(mainWindowRef.current!.webContents),
    ).resolves.toBeNull();
  });

  it('returns null when the response coordinates are out of range', async () => {
    netFetch.mockResolvedValue(jsonResponse({ latitude: 999, longitude: 0 }));

    await expect(
      invoke(mainWindowRef.current!.webContents),
    ).resolves.toBeNull();
  });

  it('returns null when the lookup throws', async () => {
    netFetch.mockRejectedValue(new Error('offline'));

    await expect(
      invoke(mainWindowRef.current!.webContents),
    ).resolves.toBeNull();
  });
});
