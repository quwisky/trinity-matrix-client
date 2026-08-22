import { describe, expect, it } from 'vitest';
import { decodeRoomSegment, encodeRoomSegment } from './room-url';

/**
 * The whole point of the encoding is which characters it CANNOT emit, so that is what most of
 * this asserts. A round-trip test alone would pass just as happily for `encodeURIComponent`,
 * which leaves the dot that breaks both SPA fallbacks.
 */
describe('room URL segments', () => {
  const ROOM_ID = '!abc:matrix.org';
  const ALIAS = '#trinity-dev:matrix.org';

  it('round-trips a room id', () => {
    expect(decodeRoomSegment(encodeRoomSegment(ROOM_ID))).toBe(ROOM_ID);
  });

  it('round-trips an alias, whose # cannot survive a URL unencoded', () => {
    expect(decodeRoomSegment(encodeRoomSegment(ALIAS))).toBe(ALIAS);
  });

  it.each([
    ['a room id', ROOM_ID],
    ['an alias', ALIAS],
    ['a server with several dots', '!x:matrix.chat.example.co.uk'],
    ['an opaque part with mixed case', '!AbCdEfGhIjK:example.org'],
    ['a very long opaque part', `!${'q'.repeat(120)}:example.org`],
  ])('emits nothing a URL path has to escape, for %s', (_label, value) => {
    const segment = encodeRoomSegment(value);

    // The four characters that made a raw id unusable, each for its own reason: the dot
    // defeats both SPA fallbacks, `#` starts a fragment, `:` reads as a scheme in a first
    // segment, `/` invents a path level.
    expect(segment).not.toMatch(/[.#:/]/);
    // And the two base64 characters that are not URL-safe, plus the padding.
    expect(segment).not.toMatch(/[+=]/);
    expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('survives a non-ASCII alias, which btoa alone cannot encode', () => {
    // `btoa` throws on anything above U+00FF, so this pins that the implementation goes
    // through UTF-8 bytes rather than UTF-16 code units.
    const unicode = '#salle-de-réunion-日本:example.org';

    expect(decodeRoomSegment(encodeRoomSegment(unicode))).toBe(unicode);
  });

  describe('decoding hostile input', () => {
    // Every caller reaches this from the URL bar, so these are the realistic inputs.
    it.each([
      ['characters outside the alphabet', 'not!a!segment'],
      ['a dot, i.e. a raw room id someone pasted', '!abc:matrix.org'],
      ['an empty segment', ''],
      ['valid base64url that is not a room reference', 'aGVsbG8'],
      ['valid base64url over bytes that are not UTF-8', '_____w'],
    ])('returns null for %s', (_label, segment) => {
      expect(decodeRoomSegment(segment)).toBeNull();
    });

    it('cannot detect a TRUNCATED segment, and does not pretend to', () => {
      // Documented limitation, pinned so nobody "fixes" the sigil check expecting it to
      // catch this. Base64 has no checksum: dropping the last character of a valid segment
      // yields another valid segment over one byte fewer, which still starts with `!`. The
      // result is a well-formed room id that no server knows, so a clipped link fails at
      // LOOKUP with "room not found" rather than at parse. Adding a checksum to catch it
      // would lengthen every URL to improve one error message.
      const clipped = encodeRoomSegment('!abc:matrix.org').slice(0, -1);

      expect(decodeRoomSegment(clipped)).toBe('!abc:matrix.or');
    });

    it('never throws, whatever it is handed', () => {
      // A resolver that throws takes the shell down; a null is something a route can branch
      // on. Asserted directly because the try/catch is the only thing standing between a
      // pasted URL and an unhandled error.
      for (const segment of ['%%%', '~~~', 'a'.repeat(5000), '-', '_']) {
        expect(() => decodeRoomSegment(segment)).not.toThrow();
      }
    });
  });

  it('is stable, so a link shared today still opens tomorrow', () => {
    // Pinned literally. The encoding is a persisted-URL format the moment anyone bookmarks
    // one, so changing it is a breaking change and should have to edit this line to happen.
    expect(encodeRoomSegment('!abc:matrix.org')).toBe('IWFiYzptYXRyaXgub3Jn');
  });
});
