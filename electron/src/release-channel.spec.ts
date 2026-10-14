import { describe, expect, it } from 'vitest';
import { CHANNEL_IDENTITY, releaseChannel } from './release-channel';

describe('releaseChannel', () => {
  it.each(['0.5.0', '1.0.0', '10.20.30'])(
    'puts plain %s on the stable channel',
    (version) => {
      expect(releaseChannel(version)).toBe('stable');
    },
  );

  it.each(['0.5.0-next.0', '1.2.3-next.14'])(
    'puts %s on the next channel',
    (version) => {
      expect(releaseChannel(version)).toBe('next');
    },
  );

  it.each([
    '0.5.0-beta.1',
    '0.5.0-next',
    '0.5.0-next.01',
    '0.5.0-next.1+build.7',
    'v0.5.0',
    '0.5',
    '01.2.3',
    ' 0.5.0',
    '',
  ])('refuses %j, so a mistyped version cannot ship as stable', (version) => {
    expect(() => releaseChannel(version)).toThrow(/Unknown release channel/);
  });
});

describe('CHANNEL_IDENTITY', () => {
  it('keeps stable Trinity exactly as released', () => {
    expect(CHANNEL_IDENTITY.stable).toEqual({
      appId: 'dev.trinityproject.trinity',
      productName: 'Trinity',
      deepLinkScheme: 'dev.trinityproject.trinity',
      displayName: 'Trinity',
    });
  });

  it('gives Trinity Next its own app ID, name and scheme', () => {
    expect(CHANNEL_IDENTITY.next).toEqual({
      appId: 'dev.trinityproject.trinity.next',
      productName: 'Trinity Next',
      deepLinkScheme: 'dev.trinityproject.trinity.next',
      displayName: 'Trinity Next',
    });
  });

  it('keeps every scheme under the reversed client_uri host, as MAS requires of native redirects', () => {
    // OIDC registers client_uri https://trinity.trinityproject.dev; Matrix Authentication
    // Service accepts a private-use redirect scheme only under that host, reversed.
    for (const identity of Object.values(CHANNEL_IDENTITY)) {
      expect(identity.deepLinkScheme.split('.').slice(0, 3)).toEqual([
        'dev',
        'trinityproject',
        'trinity',
      ]);
    }
  });
});
