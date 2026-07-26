import { describe, expect, it } from 'vitest';
import {
  chordFromEvent,
  formatChord,
  hasModifier,
  isBrowserReserved,
  matchesEvent,
  sameChord,
  type Chord,
} from './chord';

/** A KeyboardEvent-like with the fields the chord helpers read. */
function keydown(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

function chord(over: Partial<Chord> = {}): Chord {
  return { accel: false, alt: false, shift: false, key: 'k', ...over };
}

describe('chordFromEvent', () => {
  it('captures modifiers, folding Ctrl and Cmd into accel', () => {
    expect(chordFromEvent(keydown({ key: 'k', metaKey: true }))).toEqual({
      accel: true,
      alt: false,
      shift: false,
      key: 'k',
    });
    expect(chordFromEvent(keydown({ key: 'k', ctrlKey: true }))?.accel).toBe(
      true,
    );
  });

  it('reads a digit from its layout-stable code, not the key', () => {
    expect(
      chordFromEvent(keydown({ key: '1', code: 'Digit1', ctrlKey: true }))?.key,
    ).toBe('1');
  });

  it('returns null for a lone modifier press', () => {
    expect(
      chordFromEvent(keydown({ key: 'Control', ctrlKey: true })),
    ).toBeNull();
    expect(
      chordFromEvent(keydown({ key: 'Shift', shiftKey: true })),
    ).toBeNull();
  });
});

describe('matchesEvent', () => {
  it('matches accel against either Ctrl or Cmd', () => {
    const c = chord({ accel: true });
    expect(matchesEvent(c, keydown({ key: 'k', ctrlKey: true }))).toBe(true);
    expect(matchesEvent(c, keydown({ key: 'k', metaKey: true }))).toBe(true);
    expect(matchesEvent(c, keydown({ key: 'k' }))).toBe(false); // no modifier
  });

  it('requires every modifier to agree', () => {
    const c = chord({ accel: true, shift: true, key: "'" });
    expect(
      matchesEvent(c, keydown({ key: "'", ctrlKey: true, shiftKey: true })),
    ).toBe(true);
    expect(matchesEvent(c, keydown({ key: "'", ctrlKey: true }))).toBe(false);
  });

  it('compares the key case-insensitively and via the digit code', () => {
    expect(
      matchesEvent(
        chord({ alt: true, key: 'j' }),
        keydown({ key: 'J', altKey: true }),
      ),
    ).toBe(true);
    expect(
      matchesEvent(
        chord({ accel: true, key: '2' }),
        keydown({ key: '2', code: 'Digit2', ctrlKey: true }),
      ),
    ).toBe(true);
  });
});

describe('sameChord / hasModifier', () => {
  it('detects equal bindings ignoring key case', () => {
    expect(sameChord(chord({ key: 'K' }), chord({ key: 'k' }))).toBe(true);
    expect(sameChord(chord({ shift: true }), chord())).toBe(false);
  });

  it('a modifier-less chord has no modifier', () => {
    expect(hasModifier(chord({ accel: true }))).toBe(true);
    expect(hasModifier(chord({ accel: false, alt: false, shift: false }))).toBe(
      false,
    );
  });
});

describe('formatChord', () => {
  it('orders modifiers and labels arrows/keys readably', () => {
    expect(formatChord(chord({ accel: true, shift: true, key: "'" }))).toEqual([
      'Ctrl/Cmd',
      'Shift',
      "'",
    ]);
    expect(formatChord(chord({ alt: true, key: 'ArrowDown' }))).toEqual([
      'Alt',
      '↓',
    ]);
    expect(formatChord(chord({ accel: true, key: 'k' }))).toEqual([
      'Ctrl/Cmd',
      'K',
    ]);
  });
});

describe('isBrowserReserved', () => {
  it('flags the accel chords a browser eats', () => {
    expect(isBrowserReserved(chord({ accel: true, key: 'Tab' }))).toBe(true);
    expect(isBrowserReserved(chord({ accel: true, key: '3' }))).toBe(true);
    expect(isBrowserReserved(chord({ accel: true, key: 'w' }))).toBe(true);
  });

  it('leaves ordinary and non-accel chords alone', () => {
    expect(isBrowserReserved(chord({ accel: true, key: "'" }))).toBe(false);
    expect(isBrowserReserved(chord({ alt: true, key: 'ArrowDown' }))).toBe(
      false,
    );
    // Shift does not make an ordinary chord reserved.
    expect(
      isBrowserReserved(chord({ accel: true, shift: true, key: 'x' })),
    ).toBe(false);
    // Ctrl+Shift+L is not claimed by either browser, unlike Ctrl+L.
    expect(
      isBrowserReserved(chord({ accel: true, shift: true, key: 'l' })),
    ).toBe(false);
  });

  it('flags the shift chords a browser eats as well', () => {
    // Reopen-closed-tab, incognito window and close-window are as unreachable as their
    // unshifted cousins, so binding one on the web deserves the same warning.
    for (const key of ['t', 'n', 'w']) {
      expect(
        isBrowserReserved(chord({ accel: true, shift: true, key })),
        key,
      ).toBe(true);
    }
    // …as are the developer-tools chords.
    for (const key of ['i', 'j', 'c']) {
      expect(
        isBrowserReserved(chord({ accel: true, shift: true, key })),
        key,
      ).toBe(true);
    }
  });
});
