import { TestBed } from '@angular/core/testing';
import { Preferences } from '@capacitor/preferences';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigEntry } from '../config-schema';
import { KeyboardShortcutsService } from './keyboard-shortcuts.service';
import {
  shortcutOverridesEntry,
  validateShortcutOverrides,
} from './shortcut-overrides-config';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

const CTRL_J = { accel: true, alt: false, shift: false, key: 'j' };

function setup(): { entry: ConfigEntry; shortcuts: KeyboardShortcutsService } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [KeyboardShortcutsService] });
  const shortcuts = TestBed.inject(KeyboardShortcutsService);
  return { entry: shortcutOverridesEntry(shortcuts), shortcuts };
}

describe('validateShortcutOverrides', () => {
  it('accepts a set of well-formed bindings, and an explicitly unset one', () => {
    const outcome = validateShortcutOverrides({
      'switcher.open': CTRL_J,
      'format.bold': null,
    });

    expect(outcome).toEqual({
      ok: true,
      value: { 'switcher.open': CTRL_J, 'format.bold': null },
    });
  });

  it('refuses a malformed chord rather than persisting one resolve would choke on', () => {
    const outcome = validateShortcutOverrides({
      'switcher.open': { accel: 'yes', key: 42 },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.problem).toContain(
      "the binding for 'switcher.open' is not a keyboard chord",
    );
  });

  it('refuses a chord with no modifier, which would fire while you type', () => {
    const outcome = validateShortcutOverrides({
      'switcher.open': { accel: false, alt: false, shift: false, key: 'k' },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.problem).toContain(
      'would fire while you type',
    );
  });

  it('refuses anything that is not a set of bindings at all', () => {
    expect(validateShortcutOverrides([]).ok).toBe(false);
    expect(validateShortcutOverrides('switcher.open').ok).toBe(false);
  });

  it('warns about a shortcut this build does not have, and drops it', () => {
    const outcome = validateShortcutOverrides({
      'switcher.open': CTRL_J,
      'time.travel': CTRL_J,
    });

    expect(outcome).toEqual({
      ok: true,
      value: { 'switcher.open': CTRL_J },
      warning:
        'time.travel is not a shortcut this version of Trinity has, so it will not be applied',
    });
  });

  it('warns about a shortcut that cannot be rebound, and drops it', () => {
    const outcome = validateShortcutOverrides({ 'room.jump': CTRL_J });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.warning).toContain(
      'room.jump cannot be rebound',
    );
    expect(outcome.ok === true && outcome.value).toEqual({});
  });

  it('names a desktop-only binding on the web, and keeps it anyway', () => {
    // A document written in the desktop shell, applied in a browser: warn and proceed —
    // Ctrl+T never reaches the page here, but it still works where the document came from.
    const outcome = validateShortcutOverrides({
      'switcher.open': { accel: true, alt: false, shift: false, key: 't' },
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.warning).toContain(
      'only work in the desktop app',
    );
    expect(outcome.ok === true && outcome.value).toEqual({
      'switcher.open': { accel: true, alt: false, shift: false, key: 't' },
    });
  });

  it('keeps only the four chord fields, so nothing extra rides into storage', () => {
    const outcome = validateShortcutOverrides({
      'switcher.open': { ...CTRL_J, label: 'mine' },
    });

    expect(outcome.ok === true && outcome.value).toEqual({
      'switcher.open': CTRL_J,
    });
  });
});

describe('the shortcut overrides entry', () => {
  beforeEach(() => {
    vi.mocked(Preferences.get).mockReset().mockResolvedValue({ value: null });
    vi.mocked(Preferences.set).mockReset().mockResolvedValue(undefined);
  });

  it('exports only what the user rebound', () => {
    const { entry, shortcuts } = setup();
    expect(entry.read()).toEqual({});

    shortcuts.rebind('switcher.open', CTRL_J);

    expect(entry.read()).toEqual({ 'switcher.open': CTRL_J });
  });

  it('applies a document to the running service', () => {
    const { entry, shortcuts } = setup();

    entry.write({ 'format.bold': CTRL_J });

    expect(shortcuts.binding('format.bold')).toEqual(CTRL_J);
    expect(
      shortcuts.resolve({
        key: 'j',
        code: 'KeyJ',
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      } as KeyboardEvent),
    ).toEqual({ id: 'format.bold' });
  });

  it('puts a shortcut the document does not mention back to its default', () => {
    const { entry, shortcuts } = setup();
    shortcuts.rebind('switcher.open', CTRL_J);

    entry.write({});

    expect(shortcuts.list().every((shortcut) => shortcut.isDefault)).toBe(true);
  });
});
