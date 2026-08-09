import { Injectable, computed, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
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
  // Formatting — handled by the message composer, which resolves them itself and stops the
  // event before it reaches the page-level handler. They only do anything while the composer
  // has focus; everywhere else they fall through to the browser.
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
    // Accel+K would be the conventional chord, but it is already the quick switcher and
    // `resolve` is first-hit-wins — so the default cannot start there. A user who wants it
    // can rebind: `rebind` unsets whichever shortcut currently holds the chord.
    //
    // Accel+Shift+K is the other obvious candidate and is worse: it is Firefox's Web Console
    // on every platform, which the browser eats before the page sees it. Accel+Shift+U is
    // Slack's chord for the same action and is not reserved anywhere we know of.
    id: 'format.link',
    category: 'Formatting',
    description: 'Turn the selected text into a link',
    defaultChord: A({ accel: true, shift: true, key: 'u' }),
    rebindable: true,
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
        // Checked, not trusted: this used to parse straight into the signal, so a malformed
        // binding written by an older build (or by hand) reached `resolve` on every keystroke
        // for the life of the session. Anything unrecognised falls back to its default.
        this.overrides.set(acceptedOverrides(JSON.parse(value)));
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
   * Rebind `id` to `chord`, stealing it from any *rebindable* shortcut that currently holds
   * it (that one becomes unset). Persists.
   *
   * Refused when a fixed shortcut already claims the chord. `resolve` is first-hit-wins and
   * the fixed ones sit ahead of the rebindable ones, so the new binding would never fire —
   * settings would show key-caps for a chord that does something else entirely.
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
   * Replace the whole set of custom bindings at once, and persist it — how an applied
   * settings document gets its shortcuts in.
   *
   * Whole-set rather than per-shortcut because that is what the document says: a binding it
   * does not mention is back at its default, not left as this device had it. Deliberately
   * NOT routed through {@link rebind}: rebinding one at a time would let each steal a chord
   * from the next and leave shortcuts unset that the document binds. The chords are the
   * user's stated intent, so they are taken as given — the same set the export produced.
   *
   * Filtered through the same acceptance rules as {@link init}, so no caller can seat a
   * binding here that a stored one would have been refused.
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
 * The bindings out of an untrusted set that this build will actually honour.
 *
 * Drops what `resolve` could only ever mishandle: a shortcut this build does not have, one
 * that is not rebindable (a fixed chord always wins the first-hit-wins scan, so an override
 * on it is a binding the settings list would show and nothing would fire), a value that is
 * not a chord, and a chord with no modifier — which would fire while the user typed. `null`
 * survives: it is an explicitly unset shortcut, which a missing key cannot express.
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
 * Whether a fixed shortcut would swallow `chord`, by any of the routes `resolve` matches on:
 * its binding, its desktop alias, or — for the digit family — accel + any digit 1…9.
 *
 * The family check mirrors `resolve`'s, which tests only accel and `!alt`: Ctrl+Shift+3 hits
 * it just as Ctrl+3 does. Deliberately not gated on `isDesktop`, unlike `resolve`: a binding
 * persisted on the web would still be dead the moment the same person opens the desktop app.
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
