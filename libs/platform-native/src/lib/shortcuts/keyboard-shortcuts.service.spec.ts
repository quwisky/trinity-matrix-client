import { TestBed } from '@angular/core/testing';
import { Preferences } from '@capacitor/preferences';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { KeyboardShortcutsService } from './keyboard-shortcuts.service';
import { type Chord } from './chord';
import { desktopBridgeFixture } from '@trinity/testing';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn() },
}));
const get = Preferences.get as unknown as Mock;
const set = Preferences.set as unknown as Mock;

/** A KeyboardEvent-like carrying the fields resolve() reads. */
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

function chord(over: Partial<Chord>): Chord {
  return { accel: false, alt: false, shift: false, key: '', ...over };
}

function build(): KeyboardShortcutsService {
  // Resettable so a test can build a web instance then a desktop one (the service reads
  // the desktop marker at construction).
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [KeyboardShortcutsService] });
  return TestBed.inject(KeyboardShortcutsService);
}

describe('KeyboardShortcutsService', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({ value: null });
    set.mockReset().mockResolvedValue(undefined);
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
  });
  afterEach(() => {
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
  });

  it('resolves default bindings, folding Ctrl and Cmd into accel', () => {
    const svc = build();
    expect(svc.resolve(keydown({ key: 'k', metaKey: true }))).toEqual({
      id: 'switcher.open',
    });
    expect(svc.resolve(keydown({ key: "'", ctrlKey: true }))).toEqual({
      id: 'room.hop.back',
    });
    expect(
      svc.resolve(keydown({ key: 'ArrowDown', altKey: true, shiftKey: true })),
    ).toEqual({ id: 'room.walk.unread.down' });
    expect(svc.resolve(keydown({ key: 'x', ctrlKey: true }))).toBeNull();
  });

  it('gates the digit family and the Tab alias to the desktop shell', () => {
    const web = build();
    expect(
      web.resolve(keydown({ key: '1', code: 'Digit1', ctrlKey: true })),
    ).toBeNull();
    expect(web.resolve(keydown({ key: 'Tab', ctrlKey: true }))).toBeNull();

    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture();
    const desktop = build();
    expect(
      desktop.resolve(keydown({ key: '3', code: 'Digit3', ctrlKey: true })),
    ).toEqual({ id: 'room.jump', digit: 3 });
    // Ctrl+Tab is the desktop alias of hop-back.
    expect(desktop.resolve(keydown({ key: 'Tab', ctrlKey: true }))).toEqual({
      id: 'room.hop.back',
    });
  });

  it('rebinds a shortcut, and resolves the new chord instead of the old', () => {
    const svc = build();
    svc.rebind('room.hop.back', chord({ alt: true, key: 'j' }));

    expect(svc.resolve(keydown({ key: 'j', altKey: true }))).toEqual({
      id: 'room.hop.back',
    });
    expect(svc.resolve(keydown({ key: "'", ctrlKey: true }))).toBeNull();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'trinity.shortcuts.overrides' }),
    );
  });

  it('steals a chord from whoever held it, leaving them unset', () => {
    const svc = build();
    // Bind the switcher onto the hop's chord — the hop loses its binding.
    const result = svc.rebind(
      'switcher.open',
      chord({ accel: true, key: "'" }),
    );

    expect(result.ok && result.displaced).toBe('room.hop.back');
    expect(svc.resolve(keydown({ key: "'", ctrlKey: true }))).toEqual({
      id: 'switcher.open',
    });
    const hop = svc.list().find((s) => s.id === 'room.hop.back');
    expect(hop?.isUnset).toBe(true);
    expect(hop?.chord).toBeNull();
  });

  it('refuses a chord the fixed digit family already claims', () => {
    // `resolve` is first-hit-wins and the digit family sits ahead of the formatting
    // shortcuts, so accepting this would show new key-caps for a chord that jumps rooms
    // instead. The family matches accel + any digit and ignores shift.
    const svc = build();

    for (const attempt of [
      chord({ accel: true, key: '1' }),
      chord({ accel: true, shift: true, key: '7' }),
    ]) {
      const result = svc.rebind('format.bold', attempt);

      expect(result.ok, JSON.stringify(attempt)).toBe(false);
      expect(result.ok ? null : result.conflict).toBe('room.jump');
    }
    // The old binding survives a refusal.
    expect(svc.resolve(keydown({ key: 'b', ctrlKey: true }))).toEqual({
      id: 'format.bold',
    });
    expect(set).not.toHaveBeenCalled();
  });

  it('resets one shortcut and all shortcuts to their defaults', () => {
    const svc = build();
    svc.rebind('switcher.open', chord({ accel: true, key: 'p' }));
    svc.rebind('room.hop.back', chord({ alt: true, key: 'j' }));

    svc.reset('switcher.open');
    expect(svc.resolve(keydown({ key: 'k', ctrlKey: true }))).toEqual({
      id: 'switcher.open',
    });
    expect(svc.resolve(keydown({ key: 'j', altKey: true }))).toEqual({
      id: 'room.hop.back',
    }); // still custom

    svc.resetAll();
    expect(svc.resolve(keydown({ key: "'", ctrlKey: true }))).toEqual({
      id: 'room.hop.back',
    });
    expect(svc.list().every((s) => s.isDefault)).toBe(true);
  });

  it('reloads persisted overrides on init', async () => {
    get.mockResolvedValue({
      value: JSON.stringify({
        'switcher.open': { accel: true, alt: false, shift: false, key: 'p' },
      }),
    });
    const svc = build();
    await svc.init();

    expect(svc.resolve(keydown({ key: 'p', ctrlKey: true }))).toEqual({
      id: 'switcher.open',
    });
    expect(svc.resolve(keydown({ key: 'k', ctrlKey: true }))).toBeNull();
  });

  it('drops a stored binding that is not a usable chord, rather than resolving through it', async () => {
    // This used to parse straight into the signal, so a malformed binding was consulted on
    // every keystroke for the life of the session.
    get.mockResolvedValue({
      value: JSON.stringify({
        'switcher.open': { accel: 'yes', key: 42 },
        'format.bold': { accel: false, alt: false, shift: false, key: 'b' },
        'time.travel': { accel: true, alt: false, shift: false, key: 'z' },
        'format.italic': { accel: true, alt: false, shift: false, key: 'q' },
      }),
    });
    const svc = build();
    await svc.init();

    // The two broken ones fall back to their defaults; the good one is honoured.
    expect(svc.resolve(keydown({ key: 'k', ctrlKey: true }))).toEqual({
      id: 'switcher.open',
    });
    expect(svc.resolve(keydown({ key: 'b' }))).toBeNull();
    expect(svc.resolve(keydown({ key: 'b', ctrlKey: true }))).toEqual({
      id: 'format.bold',
    });
    expect(svc.resolve(keydown({ key: 'q', ctrlKey: true }))).toEqual({
      id: 'format.italic',
    });
    expect(svc.list().find((s) => s.id === 'switcher.open')?.isDefault).toBe(
      true,
    );
  });

  describe('setOverrides', () => {
    it('replaces the whole set and persists it', () => {
      const svc = build();
      svc.rebind('switcher.open', chord({ accel: true, key: 'p' }));
      set.mockClear();

      svc.setOverrides({ 'format.bold': chord({ accel: true, key: 'j' }) });

      expect(svc.resolve(keydown({ key: 'j', ctrlKey: true }))).toEqual({
        id: 'format.bold',
      });
      // Not mentioned by the new set, so it is back at its default rather than left as-is.
      expect(svc.resolve(keydown({ key: 'k', ctrlKey: true }))).toEqual({
        id: 'switcher.open',
      });
      expect(set).toHaveBeenCalledWith({
        key: 'trinity.shortcuts.overrides',
        value: JSON.stringify({
          'format.bold': { accel: true, alt: false, shift: false, key: 'j' },
        }),
      });
    });

    it('keeps an explicitly unset shortcut unset', () => {
      const svc = build();

      svc.setOverrides({ 'switcher.open': null });

      expect(svc.binding('switcher.open')).toBeNull();
      expect(svc.resolve(keydown({ key: 'k', ctrlKey: true }))).toBeNull();
    });

    it('refuses a binding a stored one would have been refused', () => {
      const svc = build();

      svc.setOverrides({
        'room.jump': chord({ accel: true, key: 'j' }),
        'format.bold': chord({ key: 'b' }),
      });

      expect(svc.list().every((s) => s.isDefault)).toBe(true);
    });
  });
});
