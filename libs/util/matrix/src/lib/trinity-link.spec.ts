import { describe, expect, it } from 'vitest';
import { parseTrinityRoomLink } from './trinity-link';

describe('parseTrinityRoomLink', () => {
  it('reads a room id link', () => {
    expect(
      parseTrinityRoomLink('eu.qwky.trinity://matrix.to/#/!abc%3Aexample.org'),
    ).toEqual({ kind: 'room', roomIdOrAlias: '!abc:example.org' });
  });

  it('reads an alias link with routing servers', () => {
    expect(
      parseTrinityRoomLink(
        'eu.qwky.trinity://matrix.to/#/%23room:example.org?via=a.org&via=b.org',
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
        'eu.qwky.trinity://matrix.to/#/!abc:example.org/$ev1',
      ),
    ).toEqual({
      kind: 'room',
      roomIdOrAlias: '!abc:example.org',
      eventId: '$ev1',
    });
  });

  it.each([
    ['unknown host', 'eu.qwky.trinity://evil.example/#/!abc:example.org'],
    [
      'look-alike host',
      'eu.qwky.trinity://matrix.to.evil.example/#/!abc:x.org',
    ],
    ['userinfo host', 'eu.qwky.trinity://matrix.to@evil.example/#/!abc:x.org'],
    ['unknown path', 'eu.qwky.trinity://matrix.to/room/#/!abc:example.org'],
    ['sso callback shape', 'eu.qwky.trinity://sso-callback?loginToken=x'],
    ['other scheme', 'https://matrix.to/#/!abc:example.org'],
    ['wrong scheme', 'javascript://matrix.to/#/!abc:example.org'],
    ['user link', 'eu.qwky.trinity://matrix.to/#/@bob:example.org'],
    ['malformed id', 'eu.qwky.trinity://matrix.to/#/room-without-sigil'],
    ['empty target', 'eu.qwky.trinity://matrix.to/#/'],
    ['bad percent escape', 'eu.qwky.trinity://matrix.to/#/%E0%A4%A'],
    ['whitespace in id', 'eu.qwky.trinity://matrix.to/#/!a%20b:example.org'],
    ['control char in id', 'eu.qwky.trinity://matrix.to/#/!a%00b:example.org'],
    ['extra segments', 'eu.qwky.trinity://matrix.to/#/!a:x.org/$e/more'],
    [
      'oversized input',
      `eu.qwky.trinity://matrix.to/#/!${'a'.repeat(3000)}:x.org`,
    ],
    ['oversized id', `eu.qwky.trinity://matrix.to/#/!${'a'.repeat(300)}:x.org`],
    ['empty string', ''],
  ])('ignores %s', (_name, url) => {
    expect(parseTrinityRoomLink(url)).toBeNull();
  });
});
