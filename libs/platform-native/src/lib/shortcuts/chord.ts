/**
 * A keyboard chord: a key plus its modifiers, platform-neutral. `accel` stands for the
 * primary accelerator — **Ctrl on Windows/Linux, Cmd on macOS** — matched against either,
 * the way every editor treats it, so one binding works everywhere.
 */
export interface Chord {
  /** Ctrl or Cmd (matched against either). */
  accel: boolean;
  alt: boolean;
  shift: boolean;
  /**
   * The non-modifier key, as `KeyboardEvent.key` — except digits, which use the
   * layout-stable position (`'1'`…`'9'` from `event.code` `Digit1`…`Digit9`). Compared
   * case-insensitively.
   */
  key: string;
}

/** Modifier keys, which never form a chord on their own. */
const MODIFIER_KEYS = new Set([
  'Control',
  'Meta',
  'Alt',
  'Shift',
  'AltGraph',
  'CapsLock',
]);

/** Build a chord from a keydown, or null for a lone modifier press (nothing to bind to). */
export function chordFromEvent(event: KeyboardEvent): Chord | null {
  if (MODIFIER_KEYS.has(event.key)) {
    return null;
  }
  return {
    accel: event.ctrlKey || event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
    key: keyOf(event),
  };
}

/** The chord's comparison key: a digit's layout-stable value, else `event.key`. */
function keyOf(event: KeyboardEvent): string {
  const digit = /^Digit([0-9])$/.exec(event.code);
  return digit ? digit[1] : event.key;
}

/** Whether a keydown matches a chord (accel = Ctrl or Cmd; all modifiers and the key agree). */
export function matchesEvent(chord: Chord, event: KeyboardEvent): boolean {
  return (
    chord.accel === (event.ctrlKey || event.metaKey) &&
    chord.alt === event.altKey &&
    chord.shift === event.shiftKey &&
    chord.key.toLowerCase() === keyOf(event).toLowerCase()
  );
}

/** Whether two chords are the same binding. */
export function sameChord(a: Chord, b: Chord): boolean {
  return (
    a.accel === b.accel &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.key.toLowerCase() === b.key.toLowerCase()
  );
}

/** Whether a chord carries any modifier — a rebind must, or it would fire while typing. */
export function hasModifier(chord: Chord): boolean {
  return chord.accel || chord.alt || chord.shift;
}

/** Human labels for a key, for readable key-caps and the chord format. */
const KEY_LABELS: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  ' ': 'Space',
  escape: 'Esc',
  tab: 'Tab',
  enter: 'Enter',
};

/** Render a chord as ordered key-cap labels, e.g. `['Ctrl/Cmd', 'Shift', "'"]`. */
export function formatChord(chord: Chord): string[] {
  const caps: string[] = [];
  if (chord.accel) {
    caps.push('Ctrl/Cmd');
  }
  if (chord.alt) {
    caps.push('Alt');
  }
  if (chord.shift) {
    caps.push('Shift');
  }
  const key = chord.key.toLowerCase();
  caps.push(
    KEY_LABELS[key] ??
      (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key),
  );
  return caps;
}

/**
 * Whether a chord is one the browser reserves for itself (tab switching, new tab/window,
 * address bar, …), so it can only work in the desktop shell. Used to warn when a user binds
 * one on the web. Deliberately a small, high-confidence set rather than an exhaustive list.
 */
export function isBrowserReserved(chord: Chord): boolean {
  if (!chord.accel || chord.alt) {
    return false;
  }
  const key = chord.key.toLowerCase();
  if (key === 'tab' || /^[1-9]$/.test(key)) {
    return true;
  }
  // Ctrl/Cmd + these open a new tab/window/location or close one — never reaches the page.
  return !chord.shift && ['w', 't', 'n', 'l'].includes(key);
}
