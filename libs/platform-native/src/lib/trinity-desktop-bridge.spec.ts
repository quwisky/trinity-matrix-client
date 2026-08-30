import { afterEach, describe, expect, it } from 'vitest';
import { desktopBridgeFixture } from '@trinity/testing';
import {
  getTrinityDesktopBridge,
  isElectronRenderer,
  type TrinityDesktopBridge,
} from './trinity-desktop-bridge';

type BridgeHost = { trinityDesktop?: unknown };

function setBridge(bridge: unknown): void {
  if (bridge === undefined) {
    delete (globalThis as BridgeHost).trinityDesktop;
    return;
  }
  (globalThis as BridgeHost).trinityDesktop = bridge;
}

function bridgeFixture(): TrinityDesktopBridge {
  return desktopBridgeFixture();
}

/** jsdom's navigator.userAgent is read-only, so swap the whole descriptor. */
function setUserAgent(userAgent: string): () => void {
  const original = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    'userAgent',
  );
  Object.defineProperty(globalThis.navigator, 'userAgent', {
    value: userAgent,
    configurable: true,
  });
  return () => {
    if (original) {
      Object.defineProperty(globalThis.navigator, 'userAgent', original);
    }
  };
}

describe('getTrinityDesktopBridge', () => {
  afterEach(() => setBridge(undefined));

  it('is undefined off the desktop shell', () => {
    expect(getTrinityDesktopBridge()).toBeUndefined();
  });

  it('hands back the preload-installed bridge', () => {
    const bridge = bridgeFixture();
    setBridge(bridge);

    expect(getTrinityDesktopBridge()).toBe(bridge);
  });

  it('rejects a protocol marker with any required capability missing', () => {
    const bridge = bridgeFixture();
    setBridge({
      ...bridge,
      capabilities: { ...bridge.capabilities, notificationPresentation: {} },
    });

    expect(getTrinityDesktopBridge()).toBeUndefined();
  });
});

describe('isElectronRenderer', () => {
  let restoreUserAgent: (() => void) | null = null;

  afterEach(() => {
    setBridge(undefined);
    restoreUserAgent?.();
    restoreUserAgent = null;
  });

  it('is false on web, where there is no bridge and no Electron user agent', () => {
    restoreUserAgent = setUserAgent('Mozilla/5.0 (X11; Linux x86_64) Chrome/1');

    expect(isElectronRenderer()).toBe(false);
  });

  it('is true from the preload marker', () => {
    restoreUserAgent = setUserAgent('Mozilla/5.0 (X11; Linux x86_64) Chrome/1');
    setBridge(bridgeFixture());

    expect(isElectronRenderer()).toBe(true);
  });

  it('falls back to the Electron user-agent token when the marker is absent', () => {
    // The fallback is what keeps the service-worker gate correct if the preload ever
    // fails to install the marker — registering a service worker under the custom
    // `trinity://` scheme is what this predicate exists to prevent.
    restoreUserAgent = setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) Electron/43.2.0 Safari/537.36',
    );

    expect(isElectronRenderer()).toBe(true);
  });

  it('is false when a bridge exists but does not claim Electron', () => {
    // Presence alone is not the signal: the entire protocol-v1 bridge is validated.
    restoreUserAgent = setUserAgent('Mozilla/5.0 (X11; Linux x86_64) Chrome/1');
    setBridge({ platform: 'darwin' });

    expect(isElectronRenderer()).toBe(false);
  });

  it('rejects a partial protocol-v1 bridge', () => {
    restoreUserAgent = setUserAgent('Mozilla/5.0 Chrome/1');
    setBridge({ protocolVersion: 1, isElectron: true, platform: 'linux' });

    expect(getTrinityDesktopBridge()).toBeUndefined();
    expect(isElectronRenderer()).toBe(false);
  });
});
