import { describe, expect, it, vi } from 'vitest';
import {
  navigateNativeShell,
  waitForNativeShellState,
} from '../e2e/android/native-shell-client.mts';

const signal = () => new AbortController().signal;

describe('native shell observations', () => {
  it('resumes only read observations interrupted by WebView closure', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('DevTools websocket closed unexpectedly'),
      )
      .mockResolvedValue('ready');
    expect(
      await waitForNativeShellState(
        read,
        (value) => value === 'ready',
        'ready',
        signal(),
        1000,
      ),
    ).toBe('ready');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('preserves arbitrary observation failures and cancellation', async () => {
    const error = new Error('Ambiguous Trinity WebView');
    const read = vi.fn().mockRejectedValue(error);
    await expect(
      waitForNativeShellState(read, () => true, 'ready', signal()),
    ).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    controller.abort(error);
    read.mockClear();
    await expect(
      waitForNativeShellState(read, () => true, 'ready', controller.signal),
    ).rejects.toBe(error);
    expect(read).not.toHaveBeenCalled();
  });
});

function navigationFixture({
  committed,
  navigation = { loaderId: 'new-loader' },
}) {
  let dispatched = false;
  const send = vi.fn(async (method) => {
    if (method === 'Page.navigate') {
      dispatched = true;
      return navigation;
    }
    return {
      result: {
        value: {
          url: 'https://localhost/login',
          timeOrigin: dispatched && committed ? 2 : 1,
        },
      },
    };
  });
  return { webview: { diagnostics: { send } }, send };
}

describe('native protected navigation', () => {
  it('waits for a new document even when the old and redirected URLs match', async () => {
    const { webview, send } = navigationFixture({ committed: true });
    await expect(
      navigateNativeShell(webview, 'https://localhost/settings', signal()),
    ).resolves.toEqual({ url: 'https://localhost/login', timeOrigin: 2 });
    expect(
      send.mock.calls.filter(([method]) => method === 'Page.navigate'),
    ).toHaveLength(1);
  });

  it('rejects an unchanged old login document without replaying navigation', async () => {
    const { webview, send } = navigationFixture({ committed: false });
    await expect(
      navigateNativeShell(webview, 'https://localhost/settings', signal(), 30),
    ).rejects.toThrow('new document after protected navigation');
    expect(
      send.mock.calls.filter(([method]) => method === 'Page.navigate'),
    ).toHaveLength(1);
  });

  it('rejects navigation errors and same-document results', async () => {
    for (const navigation of [
      { errorText: 'net::ERR_FAILED' },
      { frameId: 'old-frame' },
    ]) {
      const { webview } = navigationFixture({ committed: true, navigation });
      await expect(
        navigateNativeShell(webview, 'https://localhost/settings', signal()),
      ).rejects.toThrow('must start a new document successfully');
    }
  });
});
