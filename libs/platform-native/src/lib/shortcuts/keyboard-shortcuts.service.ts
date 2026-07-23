import { Injectable, computed, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { getTrinityDesktopBridge } from '../trinity-desktop-bridge';
import { matchesEvent, sameChord, type Chord } from './chord';

const OVERRIDES_KEY = 'trinity.shortcuts.overrides';

/** A configurable keyboard shortcut. */
export interface ShortcutDef {
  /** Stable id, also the persistence key for an override. */
  id: string;
  /** Grouping heading in the settings list. */
  category: string;
  /** One-line description shown in the list. */
  description: string;
  /** The out-of-the-box binding. */
  defaultChord: Chord;
  /** Whether the user may rebind it (false for the fixed digit family). */
  rebindable: boolean;
  /** Whether the default chord is browser-reserved (only works in the desktop shell). */
  desktopOnly?: boolean;
  /** A fixed extra chord matched on desktop only (e.g. Ctrl+Tab beside Ctrl+'). */
  desktopAlias?: Chord;
  /** `'digit'`: matches accel + 1…9 (desktop only), carrying the digit to the handler. */
  family?: 'digit';
}

/** A shortcut resolved from a keydown: its id, plus the digit for the numbered-jump family. */
export interface ShortcutHit {
  id: string;
  digit?: number;
}

/** A shortcut row for the settings list: the definition plus its live binding state. */
export interface ShortcutView extends ShortcutDef {
  /** The effective binding, or null when unset (stolen away) or a fixed family. */
  chord: Chord | null;
  isDefault: boolean;
  isUnset: boolean;
}

const A = (over: Partial<Chord>): Chord => ({
  accel: false,
  alt: false,
  shift: false,
  key: '',
  ...over,
});

/**
 * The shortcut catalog — the single source of truth for what every configurable shortcut
 * is, its default binding, and its platform constraints. Mirrors the shortcuts wired in
 * {@link RoomsPage}. The order here is the order the settings list renders.
 */
export const SHORTCUTS: readonly ShortcutDef[] = [
  {
    id: 'switcher.open',
    category: 'Navigation',
    description: 'Open the quick switcher',
    defaultChord: A({ accel: true, key: 'k' }),
    rebindable: true,
  },
  {
    id: 'room.hop.back',
    category: 'Navigation',
    description: 'Hop to the previous room (repeat to go further back)',
    defaultChord: A({ accel: true, key: "'" }),
    desktopAlias: A({ accel: true, key: 'Tab' }),
    rebindable: true,
  },
  {
    id: 'room.hop.forward',
    category: 'Navigation',
    description: 'Hop forward through recently visited rooms',
    defaultChord: A({ accel: true, shift: true, key: "'" }),
    desktopAlias: A({ accel: true, shift: true, key: 'Tab' }),
    rebindable: true,
  },
  {
    id: 'room.walk.down',
    category: 'Navigation',
    description: 'Move down the room list',
    defaultChord: A({ alt: true, key: 'ArrowDown' }),
    rebindable: true,
  },
  {
    id: 'room.walk.up',
    category: 'Navigation',
    description: 'Move up the room list',
    defaultChord: A({ alt: true, key: 'ArrowUp' }),
    rebindable: true,
  },
  {
    id: 'room.walk.unread.down',
    category: 'Navigation',
    description: 'Jump to the next unread room',
    defaultChord: A({ alt: true, shift: true, key: 'ArrowDown' }),
    rebindable: true,
  },
  {
    id: 'room.walk.unread.up',
    category: 'Navigation',
    description: 'Jump to the previous unread room',
    defaultChord: A({ alt: true, shift: true, key: 'ArrowUp' }),
    rebindable: true,
  },
  {
    id: 'room.jump',
    category: 'Navigation',
    description: 'Jump straight to one of your 9 most recent rooms',
    defaultChord: A({ accel: true, key: '1' }), // representative; the family matches 1…9
    rebindable: false,
    desktopOnly: true,
    family: 'digit',
  },
];

/**
 * The central registry of keyboard shortcuts: their definitions, the user's custom bindings
 * (persisted per device, like the other preference services), and the one `resolve` that
 * turns a keydown into a shortcut id. {@link RoomsPage} dispatches through it, and the
 * settings section reads {@link list} / rebinds through it, so a binding is defined once.
 *
 * A shortcut can be **unset**: rebinding onto a taken chord steals it, leaving the previous
 * holder with no binding (its override is an explicit `null`). {@link reset} restores a
 * default; {@link resetAll} clears every override.
 */
@Injectable({ providedIn: 'root' })
export class KeyboardShortcutsService {
  private readonly isDesktop = !!getTrinityDesktopBridge()?.isElectron;

  /** id → override chord, or `null` for an explicitly-unset shortcut. */
  private readonly overrides = signal<Record<string, Chord | null>>({});

  /** The catalog joined with each shortcut's live binding state, for the settings list. */
  readonly list = computed<ShortcutView[]>(() => {
    const overrides = this.overrides();
    return SHORTCUTS.map((def) => {
      const overridden = Object.prototype.hasOwnProperty.call(
        overrides,
        def.id,
      );
      const chord = overridden ? overrides[def.id] : def.defaultChord;
      return {
        ...def,
        chord: def.rebindable ? chord : null,
        isDefault: !overridden,
        isUnset: overridden && chord === null,
      };
    });
  });

  /** Load persisted overrides. Call once at app startup (before any shortcut fires). */
  async init(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: OVERRIDES_KEY });
      if (value) {
        this.overrides.set(JSON.parse(value) as Record<string, Chord | null>);
      }
    } catch {
      // Absent or corrupt → start with the defaults.
    }
  }

  /** The effective binding for a shortcut: its override (which may be `null`), else default. */
  binding(id: string): Chord | null {
    const overrides = this.overrides();
    if (Object.prototype.hasOwnProperty.call(overrides, id)) {
      return overrides[id];
    }
    return SHORTCUTS.find((def) => def.id === id)?.defaultChord ?? null;
  }

  /**
   * Resolve a keydown to the shortcut it triggers, or null. Honors custom bindings, the
   * desktop gate (desktop-only defaults, aliases, and the digit family only fire in the
   * Electron shell), and the digit family (returning which digit).
   */
  resolve(event: KeyboardEvent): ShortcutHit | null {
    for (const def of SHORTCUTS) {
      // The numbered-jump family matches accel + any digit 1–9, desktop only.
      if (def.family === 'digit') {
        if (
          this.isDesktop &&
          (event.ctrlKey || event.metaKey) &&
          !event.altKey
        ) {
          const digit = /^Digit([1-9])$/.exec(event.code);
          if (digit) {
            return { id: def.id, digit: Number(digit[1]) };
          }
        }
        continue;
      }
      const chord = this.binding(def.id);
      if (chord && matchesEvent(chord, event)) {
        return { id: def.id };
      }
      if (
        this.isDesktop &&
        def.desktopAlias &&
        matchesEvent(def.desktopAlias, event)
      ) {
        return { id: def.id };
      }
    }
    return null;
  }

  /**
   * Rebind `id` to `chord`, stealing it from any shortcut that currently holds it (that one
   * becomes unset). Returns the id it was stolen from, or null. Persists.
   */
  rebind(id: string, chord: Chord): { displaced: string | null } {
    const displaced =
      SHORTCUTS.find(
        (def) =>
          def.id !== id && def.rebindable && sameEffective(this, def.id, chord),
      )?.id ?? null;
    this.overrides.update((current) => {
      const next = { ...current, [id]: chord };
      if (displaced) {
        next[displaced] = null;
      }
      return next;
    });
    this.persist();
    return { displaced };
  }

  /** Restore a shortcut's default binding (drop its override). Persists. */
  reset(id: string): void {
    this.overrides.update((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    this.persist();
  }

  /** Restore every shortcut to its default. Persists. */
  resetAll(): void {
    this.overrides.set({});
    this.persist();
  }

  private persist(): void {
    void Preferences.set({
      key: OVERRIDES_KEY,
      value: JSON.stringify(this.overrides()),
    });
  }
}

/** Whether shortcut `id`'s effective binding equals `chord` (helper for steal detection). */
function sameEffective(
  svc: KeyboardShortcutsService,
  id: string,
  chord: Chord,
): boolean {
  const current = svc.binding(id);
  return current !== null && sameChord(current, chord);
}
