import { afterEach, describe, expect, it } from 'vitest';
import {
  getTrinityDesktopBridge,
  isElectronRenderer,
  type TrinityDesktopBridge,
} from './trinity-desktop-bridge';

type BridgeHost = { trinityDesktop?: TrinityDesktopBridge };

function setBridge(bridge: TrinityDesktopBridge | undefined): void {
  if (bridge === undefined) {
    delete (globalThis as BridgeHost).trinityDesktop;
    return;
  }
  (globalThis as BridgeHost).trinityDesktop = bridge;
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
    const bridge: TrinityDesktopBridge = {
      isElectron: true,
      platform: 'linux',
    };
    setBridge(bridge);

    expect(getTrinityDesktopBridge()).toBe(bridge);
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
    setBridge({ isElectron: true });

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
    // Every member of the bridge is optional, so presence alone must not be the signal.
    restoreUserAgent = setUserAgent('Mozilla/5.0 (X11; Linux x86_64) Chrome/1');
    setBridge({ platform: 'darwin' });

    expect(isElectronRenderer()).toBe(false);
  });
});
