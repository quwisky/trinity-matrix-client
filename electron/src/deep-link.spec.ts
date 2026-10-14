import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_IDENTITY, type ChannelIdentity } from './release-channel';

const {
  isReady,
  setAsDefaultProtocolClient,
  focusMainWindow,
  getMainWindow,
  identity,
} = vi.hoisted(() => ({
  isReady: vi.fn(() => true),
  setAsDefaultProtocolClient: vi.fn(),
  focusMainWindow: vi.fn(),
  getMainWindow: vi.fn(),
  identity: { current: undefined as ChannelIdentity | undefined },
}));
vi.mock('electron', () => ({ app: { isReady, setAsDefaultProtocolClient } }));
vi.mock('./window', () => ({ focusMainWindow, getMainWindow }));
vi.mock('./app-identity', () => ({ appIdentity: () => identity.current }));

import {
  DEEP_LINK_CHANNEL,
  deepLinkFromArgv,
  deliverDeepLink,
  registerDeepLinkProtocol,
} from './deep-link';

let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  identity.current = CHANNEL_IDENTITY.stable;
  send = vi.fn();
  isReady.mockReturnValue(true);
  getMainWindow.mockReturnValue({
    webContents: { send, isLoading: () => false },
  });
});

describe('deepLinkFromArgv', () => {
  it('finds the dev.trinityproject.trinity URL among process args', () => {
    expect(
      deepLinkFromArgv([
        'electron',
        '.',
        'dev.trinityproject.trinity://sso-callback?loginToken=abc',
      ]),
    ).toBe('dev.trinityproject.trinity://sso-callback?loginToken=abc');
  });

  // The OIDC callback uses the RFC 8252 §7.1 single-slash form (no authority);
  // the legacy SSO flow still uses the `//` form. Both must route.
  it('finds the RFC 8252 single-slash callback URL among process args', () => {
    expect(
      deepLinkFromArgv([
        'electron',
        '.',
        'dev.trinityproject.trinity:/sso-callback?code=abc',
      ]),
    ).toBe('dev.trinityproject.trinity:/sso-callback?code=abc');
  });

  it('returns undefined when no deep link is present', () => {
    expect(deepLinkFromArgv(['electron', '.', '--some-flag'])).toBeUndefined();
    expect(deepLinkFromArgv([])).toBeUndefined();
  });
});

describe('deliverDeepLink', () => {
  it('forwards a valid dev.trinityproject.trinity deep link to the renderer', () => {
    const url =
      'dev.trinityproject.trinity://sso-callback?loginToken=abc&sso_state=xyz';
    deliverDeepLink(url);
    expect(send).toHaveBeenCalledWith(DEEP_LINK_CHANNEL, url);
  });

  it('forwards the RFC 8252 single-slash OIDC callback to the renderer', () => {
    const url = 'dev.trinityproject.trinity:/sso-callback?code=abc&state=xyz';
    deliverDeepLink(url);
    expect(send).toHaveBeenCalledWith(DEEP_LINK_CHANNEL, url);
  });

  it('ignores anything that is not the dev.trinityproject.trinity scheme', () => {
    deliverDeepLink('https://evil.example/sso-callback');
    deliverDeepLink('javascript:alert(1)');
    deliverDeepLink('file:///etc/passwd');
    deliverDeepLink('trinity://app/rooms'); // the in-session scheme, not OS deep-link
    deliverDeepLink('dev.trinityproject.trinity.next:/sso-callback?code=abc'); // Trinity Next's
    deliverDeepLink(undefined);
    expect(send).not.toHaveBeenCalled();
  });

  it('registers stable Trinity as the handler for its own scheme', () => {
    registerDeepLinkProtocol();
    expect(setAsDefaultProtocolClient).toHaveBeenCalledExactlyOnceWith(
      'dev.trinityproject.trinity',
    );
  });
});

describe('on the Trinity Next channel', () => {
  beforeEach(() => {
    identity.current = CHANNEL_IDENTITY.next;
  });

  it('finds only its own scheme among process args', () => {
    expect(
      deepLinkFromArgv([
        'electron',
        '.',
        'dev.trinityproject.trinity://sso-callback?loginToken=a',
        'dev.trinityproject.trinity.next:/sso-callback?code=b',
      ]),
    ).toBe('dev.trinityproject.trinity.next:/sso-callback?code=b');
    expect(
      deepLinkFromArgv([
        'electron',
        '.',
        'dev.trinityproject.trinity://sso-callback?loginToken=a',
      ]),
    ).toBeUndefined();
  });

  it("forwards its own links and ignores stable Trinity's", () => {
    deliverDeepLink('dev.trinityproject.trinity://sso-callback?loginToken=abc');
    deliverDeepLink(
      'dev.trinityproject.trinity.next://matrix.to/#/!room:hs.example',
    );
    expect(send.mock.calls).toEqual([
      [
        DEEP_LINK_CHANNEL,
        'dev.trinityproject.trinity.next://matrix.to/#/!room:hs.example',
      ],
    ]);
  });

  it('registers itself as the handler for its own scheme', () => {
    registerDeepLinkProtocol();
    expect(setAsDefaultProtocolClient).toHaveBeenCalledExactlyOnceWith(
      'dev.trinityproject.trinity.next',
    );
  });
});
