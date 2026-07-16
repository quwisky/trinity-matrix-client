import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isReady, focusMainWindow, getMainWindow } = vi.hoisted(() => ({
  isReady: vi.fn(() => true),
  focusMainWindow: vi.fn(),
  getMainWindow: vi.fn(),
}));
vi.mock('electron', () => ({ app: { isReady } }));
vi.mock('./window', () => ({ focusMainWindow, getMainWindow }));

import {
  DEEP_LINK_CHANNEL,
  deepLinkFromArgv,
  deliverDeepLink,
} from './deep-link';

describe('deepLinkFromArgv', () => {
  it('finds the eu.qwky.trinity URL among process args', () => {
    expect(
      deepLinkFromArgv([
        'electron',
        '.',
        'eu.qwky.trinity://sso-callback?loginToken=abc',
      ]),
    ).toBe('eu.qwky.trinity://sso-callback?loginToken=abc');
  });

  // The OIDC callback uses the RFC 8252 §7.1 single-slash form (no authority);
  // the legacy SSO flow still uses the `//` form. Both must route.
  it('finds the RFC 8252 single-slash callback URL among process args', () => {
    expect(
      deepLinkFromArgv([
        'electron',
        '.',
        'eu.qwky.trinity:/sso-callback?code=abc',
      ]),
    ).toBe('eu.qwky.trinity:/sso-callback?code=abc');
  });

  it('returns undefined when no deep link is present', () => {
    expect(deepLinkFromArgv(['electron', '.', '--some-flag'])).toBeUndefined();
    expect(deepLinkFromArgv([])).toBeUndefined();
  });
});

describe('deliverDeepLink', () => {
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn();
    isReady.mockReturnValue(true);
    getMainWindow.mockReturnValue({
      webContents: { send, isLoading: () => false },
    });
  });

  it('forwards a valid eu.qwky.trinity deep link to the renderer', () => {
    const url = 'eu.qwky.trinity://sso-callback?loginToken=abc&sso_state=xyz';
    deliverDeepLink(url);
    expect(send).toHaveBeenCalledWith(DEEP_LINK_CHANNEL, url);
  });

  it('forwards the RFC 8252 single-slash OIDC callback to the renderer', () => {
    const url = 'eu.qwky.trinity:/sso-callback?code=abc&state=xyz';
    deliverDeepLink(url);
    expect(send).toHaveBeenCalledWith(DEEP_LINK_CHANNEL, url);
  });

  it('ignores anything that is not the eu.qwky.trinity scheme', () => {
    deliverDeepLink('https://evil.example/sso-callback');
    deliverDeepLink('javascript:alert(1)');
    deliverDeepLink('file:///etc/passwd');
    deliverDeepLink('trinity://app/rooms'); // the in-session scheme, not OS deep-link
    deliverDeepLink(undefined);
    expect(send).not.toHaveBeenCalled();
  });
});
