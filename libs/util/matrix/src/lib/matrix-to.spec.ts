import { describe, expect, it } from 'vitest';
import {
  isMatrixLinkHref,
  matrixToPermalink,
  messagePermalink,
  parseMatrixLink,
  parseMatrixToLink,
} from './matrix-to';

describe('messagePermalink', () => {
  it('builds a permalink to an event, percent-encoding ids + a via for a room id', () => {
    // A room-ID link needs a routing hint; default to the room's origin server.
    expect(messagePermalink('!room:hs', '$evt')).toBe(
      'https://matrix.to/#/!room%3Ahs/%24evt?via=hs',
    );
  });

  it('omits via for an alias link (aliases resolve on their own)', () => {
    expect(messagePermalink('#general:hs', '$evt')).toBe(
      'https://matrix.to/#/%23general%3Ahs/%24evt',
    );
  });

  it('uses explicitly supplied via servers when given', () => {
    expect(messagePermalink('!room:hs', '$evt', ['a.org', 'b.org'])).toBe(
      'https://matrix.to/#/!room%3Ahs/%24evt?via=a.org&via=b.org',
    );
  });

  it('round-trips back through parseMatrixToLink with its via hint', () => {
    expect(parseMatrixToLink(messagePermalink('!room:hs', '$evt'))).toEqual({
      kind: 'room',
      roomIdOrAlias: '!room:hs',
      eventId: '$evt',
      via: ['hs'],
    });
  });
});

describe('parseMatrixToLink', () => {
  it('parses a user permalink', () => {
    expect(parseMatrixToLink('https://matrix.to/#/@alice:hs')).toEqual({
      kind: 'user',
      userId: '@alice:hs',
    });
  });

  it('parses a room-id permalink', () => {
    expect(parseMatrixToLink('https://matrix.to/#/!room:hs')).toEqual({
      kind: 'room',
      roomIdOrAlias: '!room:hs',
    });
  });

  it('parses a room-alias permalink', () => {
    expect(parseMatrixToLink('https://matrix.to/#/#general:hs')).toEqual({
      kind: 'room',
      roomIdOrAlias: '#general:hs',
    });
  });

  it('parses an event permalink with its room', () => {
    expect(parseMatrixToLink('https://matrix.to/#/!room:hs/$evt')).toEqual({
      kind: 'room',
      roomIdOrAlias: '!room:hs',
      eventId: '$evt',
    });
  });

  it('percent-decodes the sigil-prefixed ids', () => {
    expect(parseMatrixToLink('https://matrix.to/#/%40bob%3Ahs')).toEqual({
      kind: 'user',
      userId: '@bob:hs',
    });
  });

  it('preserves a valid via query string', () => {
    expect(
      parseMatrixToLink('https://matrix.to/#/!room:hs?via=hs.example'),
    ).toEqual({
      kind: 'room',
      roomIdOrAlias: '!room:hs',
      via: ['hs.example'],
    });
  });

  it('returns null for a non-matrix.to link', () => {
    expect(parseMatrixToLink('https://example.com/@alice:hs')).toBeNull();
  });

  it('returns null for an unrecognised target sigil', () => {
    expect(parseMatrixToLink('https://matrix.to/#/+community:hs')).toBeNull();
  });

  it('returns null for an empty fragment', () => {
    expect(parseMatrixToLink('https://matrix.to/#/')).toBeNull();
  });
});

describe('parseMatrixLink', () => {
  it.each([
    ['matrix:u/alice:hs', { kind: 'user', userId: '@alice:hs' }],
    ['matrix:r/general:hs', { kind: 'room', roomIdOrAlias: '#general:hs' }],
    ['matrix:roomid/room:hs', { kind: 'room', roomIdOrAlias: '!room:hs' }],
    [
      'matrix:r/general:hs/e/event-id',
      {
        kind: 'room',
        roomIdOrAlias: '#general:hs',
        eventId: '$event-id',
      },
    ],
    [
      'matrix:roomid/room:hs/event/event-id',
      {
        kind: 'room',
        roomIdOrAlias: '!room:hs',
        eventId: '$event-id',
      },
    ],
  ])('parses %s', (href, target) => {
    expect(parseMatrixLink(href)).toEqual(target);
  });

  it('preserves distinct valid via hints and caps them to the SDK limit', () => {
    expect(
      parseMatrixLink(
        'matrix:roomid/r:remote?via=a.example&via=a.example&via=bad/path&via=b.example:8448&via=%5B%3A%3A1%5D%3A8448&via=ignored.example',
      ),
    ).toEqual({
      kind: 'room',
      roomIdOrAlias: '!r:remote',
      via: ['a.example', 'b.example:8448', '[::1]:8448'],
    });
  });

  it.each([
    'matrix:',
    'matrix:u/',
    'matrix:unknown/value',
    'matrix:r/room:hs/not-event/x',
    'matrix:roomid/%E0%A4%A',
    'https://matrix.to/#/!room:hs/not-an-event',
  ])('rejects malformed Matrix link %s', (href) => {
    expect(parseMatrixLink(href)).toBeNull();
    expect(isMatrixLinkHref(href)).toBe(true);
  });

  it('does not classify an ordinary URL as a Matrix link', () => {
    expect(isMatrixLinkHref('https://example.org/matrix:r/foo')).toBe(false);
    expect(parseMatrixLink('https://example.org/matrix:r/foo')).toBeNull();
  });

  it('rewrites a parsed Matrix URI to a safe matrix.to permalink', () => {
    const target = parseMatrixLink('matrix:roomid/room:hs?via=remote.example');
    expect(target && matrixToPermalink(target)).toBe(
      'https://matrix.to/#/!room%3Ahs?via=remote.example',
    );
  });
});
