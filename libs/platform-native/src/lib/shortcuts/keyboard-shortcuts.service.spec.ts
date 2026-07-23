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

    (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
      isElectron: true,
    };
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

    expect(result.displaced).toBe('room.hop.back');
    expect(svc.resolve(keydown({ key: "'", ctrlKey: true }))).toEqual({
      id: 'switcher.open',
    });
    const hop = svc.list().find((s) => s.id === 'room.hop.back');
    expect(hop?.isUnset).toBe(true);
    expect(hop?.chord).toBeNull();
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
});
