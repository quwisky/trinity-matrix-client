import { describe, expect, it } from 'vitest';
import { parseMatrixToLink } from './matrix-to';

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

  it('drops a via query string', () => {
    expect(
      parseMatrixToLink('https://matrix.to/#/!room:hs?via=hs.example'),
    ).toEqual({ kind: 'room', roomIdOrAlias: '!room:hs' });
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
