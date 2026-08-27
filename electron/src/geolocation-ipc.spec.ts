import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fakes for the native surface the handler touches. vi.hoisted so they exist when
// the mock factories run. `mainWindowRef` is a mutable holder the getMainWindow
// mock reads, letting each test swap in a fake window (or null).
const {
  handlers,
  netFetch,
  mainWindowRef,
  nativeProvider,
  confirmCurrentLocation,
} = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  netFetch: vi.fn(),
  mainWindowRef: {
    current: null as {
      webContents: {
        mainFrame: {
          url: string;
          detached: boolean;
          isDestroyed: () => boolean;
        };
        getURL: () => string;
        isDestroyed: () => boolean;
      };
      isVisible: () => boolean;
      isFocused: () => boolean;
      isDestroyed: () => boolean;
    } | null,
  },
  nativeProvider: {
    syntheticE2E: false,
    requestCurrentLocation: vi.fn(),
  },
  confirmCurrentLocation: vi.fn(),
}));

vi.mock('electron', () => ({
  dialog: { showMessageBox: vi.fn() },
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
  CURRENT_LOCATION_CHANNEL,
  registerGeolocationIpc,
} from './geolocation-ipc';

registerGeolocationIpc(nativeProvider, confirmCurrentLocation);
const handler = handlers.get(APPROX_LOCATION_CHANNEL);
const currentHandler = handlers.get(CURRENT_LOCATION_CHANNEL);

/** Invoke the captured IPC handler as if from `sender`. */
function invoke(sender: unknown): Promise<unknown> {
  return Promise.resolve(handler?.({ sender }));
}

function invokeCurrent(
  sender: unknown,
  senderFrame?: unknown,
): Promise<unknown> {
  return Promise.resolve(currentHandler?.({ sender, senderFrame }));
}

/** A fake fetch Response carrying `body` (or a non-ok status). */
function jsonResponse(body: unknown, ok = true): unknown {
  return { ok, json: () => Promise.resolve(body) };
}

describe('registerGeolocationIpc', () => {
  beforeEach(() => {
    // Default: our real main window is the caller, lookup succeeds.
    const mainFrame = {
      url: 'trinity://app/rooms',
      detached: false,
      isDestroyed: () => false,
    };
    mainWindowRef.current = {
      webContents: {
        mainFrame,
        getURL: () => mainFrame.url,
        isDestroyed: () => false,
      },
      isVisible: () => true,
      isFocused: () => true,
      isDestroyed: () => false,
    };
    nativeProvider.syntheticE2E = false;
    confirmCurrentLocation.mockResolvedValue(true);
    netFetch.mockResolvedValue(
      jsonResponse({ latitude: 48.8584, longitude: 2.2945 }),
    );
    nativeProvider.requestCurrentLocation.mockResolvedValue({
      status: 'ok',
      lat: 48.8584,
      lng: 2.2945,
      accuracy: 25,
    });
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

  it('returns an OS location only to the visible, focused main renderer', async () => {
    await expect(
      invokeCurrent(
        mainWindowRef.current!.webContents,
        mainWindowRef.current!.webContents.mainFrame,
      ),
    ).resolves.toEqual({
      status: 'ok',
      lat: 48.8584,
      lng: 2.2945,
      accuracy: 25,
    });
    expect(confirmCurrentLocation).toHaveBeenCalledWith(mainWindowRef.current);
    expect(nativeProvider.requestCurrentLocation).toHaveBeenCalledOnce();
  });

  it('does not start native location for another sender or an unfocused window', async () => {
    await expect(invokeCurrent({})).resolves.toEqual({
      status: 'unavailable',
    });
    mainWindowRef.current!.isFocused = () => false;
    await expect(
      invokeCurrent(
        mainWindowRef.current!.webContents,
        mainWindowRef.current!.webContents.mainFrame,
      ),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(confirmCurrentLocation).not.toHaveBeenCalled();
    expect(nativeProvider.requestCurrentLocation).not.toHaveBeenCalled();
  });

  it('does not start native location when the user declines confirmation', async () => {
    confirmCurrentLocation.mockResolvedValue(false);

    await expect(
      invokeCurrent(
        mainWindowRef.current!.webContents,
        mainWindowRef.current!.webContents.mainFrame,
      ),
    ).resolves.toEqual({ status: 'cancelled' });

    expect(confirmCurrentLocation).toHaveBeenCalledOnce();
    expect(nativeProvider.requestCurrentLocation).not.toHaveBeenCalled();
  });

  it('coalesces concurrent renderer requests into one native request', async () => {
    let finish!: (value: { status: 'timeout' }) => void;
    nativeProvider.requestCurrentLocation.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { webContents } = mainWindowRef.current!;
    const first = invokeCurrent(webContents, webContents.mainFrame);
    const second = invokeCurrent(webContents, webContents.mainFrame);
    finish({ status: 'timeout' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'timeout' },
      { status: 'timeout' },
    ]);
    expect(confirmCurrentLocation).toHaveBeenCalledOnce();
    expect(nativeProvider.requestCurrentLocation).toHaveBeenCalledOnce();
  });

  it('does not let a new renderer document join an authorized request', async () => {
    let finishConfirmation!: (confirmed: boolean) => void;
    confirmCurrentLocation.mockReturnValue(
      new Promise((resolve) => {
        finishConfirmation = resolve;
      }),
    );
    const { webContents } = mainWindowRef.current!;
    const oldFrame = webContents.mainFrame;
    const first = invokeCurrent(webContents, oldFrame);
    const newFrame = {
      url: 'trinity://app/rooms',
      detached: false,
      isDestroyed: () => false,
    };
    webContents.mainFrame = newFrame;

    await expect(invokeCurrent(webContents, newFrame)).resolves.toEqual({
      status: 'unavailable',
    });
    finishConfirmation(true);
    await expect(first).resolves.toEqual({ status: 'cancelled' });
    expect(nativeProvider.requestCurrentLocation).not.toHaveBeenCalled();
  });

  it('withholds a resolved location when the window loses focus', async () => {
    let finish!: (value: {
      status: 'ok';
      lat: number;
      lng: number;
      accuracy: number;
    }) => void;
    nativeProvider.requestCurrentLocation.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { webContents } = mainWindowRef.current!;
    const request = invokeCurrent(webContents, webContents.mainFrame);
    await Promise.resolve();
    mainWindowRef.current!.isFocused = () => false;
    finish({ status: 'ok', lat: 48.8584, lng: 2.2945, accuracy: 25 });

    await expect(request).resolves.toEqual({ status: 'cancelled' });
  });

  it('allows only the synthetic E2E provider to bypass focus and confirmation', async () => {
    nativeProvider.syntheticE2E = true;
    mainWindowRef.current!.isFocused = () => false;
    const { webContents } = mainWindowRef.current!;

    await expect(
      invokeCurrent(webContents, webContents.mainFrame),
    ).resolves.toMatchObject({ status: 'ok' });

    expect(confirmCurrentLocation).not.toHaveBeenCalled();
    expect(nativeProvider.requestCurrentLocation).toHaveBeenCalledOnce();
  });
});
