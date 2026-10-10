import { describe, expect, it } from 'vitest';
import { parseTrinityRoomLink } from './trinity-link';

describe('parseTrinityRoomLink', () => {
  it('reads a room id link', () => {
    expect(
      parseTrinityRoomLink(
        'dev.trinityproject.trinity://matrix.to/#/!abc%3Aexample.org',
      ),
    ).toEqual({ kind: 'room', roomIdOrAlias: '!abc:example.org' });
  });

  it('reads an alias link with routing servers', () => {
    expect(
      parseTrinityRoomLink(
        'dev.trinityproject.trinity://matrix.to/#/%23room:example.org?via=a.org&via=b.org',
      ),
    ).toEqual({
      kind: 'room',
      roomIdOrAlias: '#room:example.org',
      via: ['a.org', 'b.org'],
    });
  });

  it('reads an event link', () => {
    expect(
      parseTrinityRoomLink(
        'dev.trinityproject.trinity://matrix.to/#/!abc:example.org/$ev1',
      ),
    ).toEqual({
      kind: 'room',
      roomIdOrAlias: '!abc:example.org',
      eventId: '$ev1',
    });
  });

  it.each([
    [
      'unknown host',
      'dev.trinityproject.trinity://evil.example/#/!abc:example.org',
    ],
    [
      'look-alike host',
      'dev.trinityproject.trinity://matrix.to.evil.example/#/!abc:x.org',
    ],
    [
      'userinfo host',
      'dev.trinityproject.trinity://matrix.to@evil.example/#/!abc:x.org',
    ],
    [
      'unknown path',
      'dev.trinityproject.trinity://matrix.to/room/#/!abc:example.org',
    ],
    [
      'sso callback shape',
      'dev.trinityproject.trinity://sso-callback?loginToken=x',
    ],
    ['other scheme', 'https://matrix.to/#/!abc:example.org'],
    ['wrong scheme', 'javascript://matrix.to/#/!abc:example.org'],
    ['user link', 'dev.trinityproject.trinity://matrix.to/#/@bob:example.org'],
    [
      'malformed id',
      'dev.trinityproject.trinity://matrix.to/#/room-without-sigil',
    ],
    ['empty target', 'dev.trinityproject.trinity://matrix.to/#/'],
    ['bad percent escape', 'dev.trinityproject.trinity://matrix.to/#/%E0%A4%A'],
    [
      'whitespace in id',
      'dev.trinityproject.trinity://matrix.to/#/!a%20b:example.org',
    ],
    [
      'control char in id',
      'dev.trinityproject.trinity://matrix.to/#/!a%00b:example.org',
    ],
    [
      'extra segments',
      'dev.trinityproject.trinity://matrix.to/#/!a:x.org/$e/more',
    ],
    [
      'oversized input',
      `dev.trinityproject.trinity://matrix.to/#/!${'a'.repeat(3000)}:x.org`,
    ],
    [
      'oversized id',
      `dev.trinityproject.trinity://matrix.to/#/!${'a'.repeat(300)}:x.org`,
    ],
    ['empty string', ''],
  ])('ignores %s', (_name, url) => {
    expect(parseTrinityRoomLink(url)).toBeNull();
  });

  it('does not treat the retired eu.qwky.trinity scheme as a Trinity link', () => {
    expect(
      parseTrinityRoomLink('eu.qwky.trinity://matrix.to/#/!room:example.org'),
    ).toBeNull();
  });
});
