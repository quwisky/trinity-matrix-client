import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { TrnEmojiIndex } from './trn-emoji-index.service';

/**
 * Driven against the REAL `EmojiSearch`/`EmojiService`, not stubs.
 *
 * The facade's whole job is translating the vendor's shapes into ours, so a test that
 * stubbed the vendor would assert the translation against a fiction and pass even if the
 * vendor's API moved. #152's own risk note says as much: keep at least one test driving
 * the real index through the facade.
 */
describe('TrnEmojiIndex', () => {
  const index = () => TestBed.inject(TrnEmojiIndex);

  it('suggests completions in Trinity’s shape', () => {
    const found = index().suggest('rocket');

    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toEqual({
      id: expect.any(String),
      native: expect.any(String),
      colons: expect.any(String),
    });
    expect(found.some((entry) => entry.native === '🚀')).toBe(true);
  });

  it('honours an explicit limit, which is what keeps the menu a menu', () => {
    expect(index().suggest('a', 3).length).toBeLessThanOrEqual(3);
  });

  it('caps an unbounded query with its own default', () => {
    // The default became load-bearing when the caller's own constant was removed: the
    // autocomplete now calls `suggest(q)` with no limit, so an uncapped facade would put
    // every match for a one-letter query into the suggestion menu.
    const wide = index().suggest('a');

    expect(wide.length).toBeGreaterThan(0);
    expect(wide.length).toBeLessThanOrEqual(8);
  });

  it('resolves a shortcode to its character', () => {
    expect(index().nativeFor('rocket')).toBe('🚀');
  });

  it('returns null for a shortcode that names nothing', () => {
    // Null rather than the input echoed back: the composer converts `:shrug:` in place,
    // and a passthrough would leave an unresolved shortcode looking resolved.
    expect(index().nativeFor('definitely-not-an-emoji')).toBeNull();
  });
});
