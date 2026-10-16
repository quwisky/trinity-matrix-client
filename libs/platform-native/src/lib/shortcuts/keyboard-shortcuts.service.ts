import { Injectable, computed, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import {
  preferenceInitializationDefaulted,
  preferenceInitializationReady,
  type PreferenceInitializationOutcome,
} from '../preference-initialization';
import { getTrinityDesktopBridge } from '../trinity-desktop-bridge';
import {
  hasModifier,
  isChord,
  matchesEvent,
  sameChord,
  type Chord,
} from './chord';

const OVERRIDES_KEY = 'trinity.shortcuts.overrides';

/** A configurable keyboard shortcut. */
export interface ShortcutDef {
  /** Stable id, also the persistence key for an override. */
  id: string;
  /** Grouping heading in the settings list. */
  category: string;
  /** One-line description shown in the list. */
  description: string;
  /** The out-of-the-box binding; null for a shortcut that ships unassigned. */
  defaultChord: Chord | null;
  /** Whether the user may rebind it (false for the fixed digit family). */
  rebindable: boolean;
  /** Whether the default chord is browser-reserved (only works in the desktop shell). */
  desktopOnly?: boolean;
  /** A fixed extra chord matched on desktop only (e.g. Ctrl+Tab beside Ctrl+'). */
  desktopAlias?: Chord;
  /** `'digit'`: matches accel + 1…9 (desktop only), carrying the digit to the handler. */
  family?: 'digit';
}

/**
 * The outcome of a rebind: either it took (naming whichever rebindable shortcut lost the
 * chord), or a fixed shortcut already claims it and nothing changed.
 */
export type RebindResult =
  { ok: true; displaced: string | null } | { ok: false; conflict: string };

/** A shortcut resolved from a keydown: its id, plus the digit for the numbered-jump family. */
export interface ShortcutHit {
  id: string;
  digit?: number;
}

/** A shortcut row for the settings list: the definition plus its live binding state. */
export interface ShortcutView extends ShortcutDef {
  /** The effective binding, or null when unset (stolen away or shipped so) or a fixed family. */
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
 * The shortcut catalog: every configurable shortcut, in the order the settings list renders.
 * Mirrors the shortcuts wired in {@link RoomsPage}.
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
    id: 'room.search',
    category: 'Navigation',
    description: 'Search messages in this room',
    defaultChord: A({ accel: true, key: 'f' }),
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
  // The Rooms shell checks it before its open-dialog guard, so it works over Settings too.
  // Ships unassigned so no habit locks the app by surprise; acts only while App lock is on
  // and unlocked.
  {
    id: 'lock.now',
    category: 'General',
    description: 'Lock Trinity',
    defaultChord: null,
    rebindable: true,
  },
  // Formatting: the composer resolves these itself and stops the event before the page-level
  // handler. Active only while the composer has focus; elsewhere they fall through to the browser.
  {
    id: 'format.bold',
    category: 'Formatting',
    description: 'Bold the selected text',
    defaultChord: A({ accel: true, key: 'b' }),
    rebindable: true,
  },
  {
    id: 'format.italic',
    category: 'Formatting',
    description: 'Italicise the selected text',
    defaultChord: A({ accel: true, key: 'i' }),
    rebindable: true,
  },
  {
    id: 'format.strike',
    category: 'Formatting',
    description: 'Strike through the selected text',
    defaultChord: A({ accel: true, shift: true, key: 'x' }),
    rebindable: true,
  },
  {
    id: 'format.code',
    category: 'Formatting',
    description: 'Format the selected text as inline code',
    defaultChord: A({ accel: true, key: '`' }),
    rebindable: true,
  },
  {
    // Not Accel+K: that is the quick switcher and `resolve` is first-hit-wins. Not
    // Accel+Shift+K either: it is Firefox's Web Console, which the browser eats before the
    // page sees it. Accel+Shift+U is not reserved anywhere we know of.
    id: 'format.link',
    category: 'Formatting',
    description: 'Turn the selected text into a link',
    defaultChord: A({ accel: true, shift: true, key: 'u' }),
    rebindable: true,
  },
];

/**
 * Registry of keyboard shortcuts and the user's per-device custom bindings; `resolve` turns
 * a keydown into a shortcut id.
 *
 * A shortcut can be unset: rebinding onto a taken chord steals it, leaving the previous
 * holder with an explicit `null` override. One can also ship unset (`defaultChord: null`).
 */
@Injectable({ providedIn: 'root' })
export class KeyboardShortcutsService {
  private readonly isDesktop = !!getTrinityDesktopBridge()?.isElectron;

  /** id → override chord, or `null` for an explicitly-unset shortcut. */
  private readonly overrides = signal<Record<string, Chord | null>>({});
  /**
   * The captures in progress: while Settings waits for a new chord, a keypress is that
   * chord, not a shortcut. Each capture owns its entry, so one ending never ends another.
   */
  private readonly captures = new Set<symbol>();

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
        // Unset: taken away by a rebind, or shipped without a binding.
        isUnset: def.rebindable && chord === null,
      };
    });
  });

  /** Load persisted overrides. Call once at app startup (before any shortcut fires). */
  async init(): Promise<PreferenceInitializationOutcome> {
    let value: string | null;
    try {
      ({ value } = await Preferences.get({ key: OVERRIDES_KEY }));
    } catch {
      return preferenceInitializationDefaulted('storage-unavailable');
    }
    if (!value) return preferenceInitializationReady;
    try {
      // Checked, not trusted: a malformed stored binding would otherwise reach `resolve` on
      // every keystroke. Anything unrecognised falls back to its default.
      this.overrides.set(acceptedOverrides(JSON.parse(value)));
      return preferenceInitializationReady;
    } catch {
      return preferenceInitializationDefaulted('invalid-stored-value');
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
   * Resolve a keydown to the shortcut it triggers, or null. Desktop-only defaults, aliases
   * and the digit family fire only in the Electron shell.
   */
  resolve(event: KeyboardEvent): ShortcutHit | null {
    if (this.captures.size > 0) {
      return null;
    }
    for (const def of SHORTCUTS) {
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
   * Hold every shortcut while Settings captures a new chord. The page's handler sees a key
   * before the capture listener (for Lock Trinity, even over Settings), so without this,
   * pressing a chord to bind it would run the shortcut that holds it.
   *
   * Returns the release for this capture alone; calling it again does nothing.
   */
  holdForCapture(): () => void {
    const capture = Symbol('shortcut-capture');
    this.captures.add(capture);
    return () => {
      this.captures.delete(capture);
    };
  }

  /**
   * Rebind `id` to `chord`, stealing it from any *rebindable* shortcut that currently holds
   * it (that one becomes unset). Persists.
   *
   * Refused when a fixed shortcut already claims the chord: `resolve` is first-hit-wins and
   * fixed ones sit ahead, so the new binding would never fire.
   */
  rebind(id: string, chord: Chord): RebindResult {
    const conflict = SHORTCUTS.find(
      (def) =>
        def.id !== id && !def.rebindable && claimsChord(this, def, chord),
    );
    if (conflict) {
      return { ok: false, conflict: conflict.id };
    }
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
    return { ok: true, displaced };
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

  /**
   * Replace the whole set of custom bindings and persist it (how an applied settings
   * document seats its shortcuts). A binding the set does not mention returns to its default.
   *
   * Deliberately not routed through {@link rebind}: one at a time, each would steal a chord
   * from the next and leave unset shortcuts the document binds. Filtered through the same
   * acceptance rules as {@link init}.
   */
  setOverrides(overrides: Record<string, Chord | null>): void {
    this.overrides.set(acceptedOverrides(overrides));
    this.persist();
  }

  private persist(): void {
    void Preferences.set({
      key: OVERRIDES_KEY,
      value: JSON.stringify(this.overrides()),
    });
  }
}

/**
 * The bindings out of an untrusted set that this build will honour.
 *
 * Drops unknown shortcuts, non-rebindable ones (a fixed chord always wins the first-hit-wins
 * scan), non-chord values, and chords with no modifier, which would fire while the user
 * typed. `null` survives: it is an explicitly unset shortcut.
 */
function acceptedOverrides(value: unknown): Record<string, Chord | null> {
  const accepted: Record<string, Chord | null> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return accepted;
  }
  for (const [id, binding] of Object.entries(value)) {
    const def = SHORTCUTS.find((candidate) => candidate.id === id);
    if (!def?.rebindable) {
      continue;
    }
    if (binding === null) {
      accepted[id] = null;
    } else if (isChord(binding) && hasModifier(binding)) {
      // Copied field by field so nothing extra rides along into storage.
      accepted[id] = {
        accel: binding.accel,
        alt: binding.alt,
        shift: binding.shift,
        key: binding.key,
      };
    }
  }
  return accepted;
}

/**
 * Whether a fixed shortcut would swallow `chord`: via its binding, its desktop alias, or
 * (digit family) accel + any digit 1…9.
 *
 * The family check mirrors `resolve`'s, which tests only accel and `!alt`, so Ctrl+Shift+3
 * hits it too. Deliberately not gated on `isDesktop`: a binding persisted on the web would be
 * dead once the same person opens the desktop app.
 */
function claimsChord(
  svc: KeyboardShortcutsService,
  def: ShortcutDef,
  chord: Chord,
): boolean {
  if (def.family === 'digit') {
    return chord.accel && !chord.alt && /^[1-9]$/.test(chord.key);
  }
  return (
    sameEffective(svc, def.id, chord) ||
    (def.desktopAlias !== undefined && sameChord(def.desktopAlias, chord))
  );
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
