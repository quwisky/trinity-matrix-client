import { describeConfigValue, isConfigRecord } from '../config-validation';
import type {
  ConfigEntry,
  ConfigValidation,
  ConfigValue,
} from '../config-entry';
import { getTrinityDesktopBridge } from '../trinity-desktop-bridge';
import { hasModifier, isBrowserReserved, isChord, type Chord } from './chord';
import {
  SHORTCUTS,
  type KeyboardShortcutsService,
} from './keyboard-shortcuts.service';

/**
 * The keyboard shortcuts, for the config export. Its value is a map the user can write
 * freely, so {@link validateShortcutOverrides} is the boundary for a pasted document; the
 * service applies the same rules to what it loads from storage.
 */
export function shortcutOverridesEntry(
  shortcuts: KeyboardShortcutsService,
): ConfigEntry {
  return {
    path: 'shortcuts.overrides',
    key: 'trinity.shortcuts.overrides',
    description:
      'The shortcuts you have rebound, by shortcut id; null means one you left unbound. ' +
      'Shortcuts you have not changed are not listed.',
    // Always an object, empty when nothing is rebound, so there is no "absent" shape.
    type: 'object',
    // Only what the user changed: defaults differ by platform, so exporting them would pin
    // one device's bindings into a document another device must ignore. `null` is a
    // shortcut left unbound after another stole its chord, which a missing key cannot say.
    read: () => {
      const overrides: { [id: string]: ConfigValue } = {};
      for (const shortcut of shortcuts.list()) {
        if (shortcut.isDefault) {
          continue;
        }
        overrides[shortcut.id] = shortcut.chord
          ? {
              accel: shortcut.chord.accel,
              alt: shortcut.chord.alt,
              shift: shortcut.chord.shift,
              key: shortcut.chord.key,
            }
          : null;
      }
      return overrides;
    },
    reset: () => shortcuts.resetAll(),
    validate: validateShortcutOverrides,
    write: (value) => shortcuts.setOverrides(toBindings(value)),
  };
}

/**
 * Check a pasted set of custom bindings. A value that is not a chord is a broken document
 * and fails the whole import; a chord for a shortcut this build lacks (or cannot rebind) is
 * named and dropped with a warning, and everything else still applies.
 */
export function validateShortcutOverrides(value: unknown): ConfigValidation {
  if (!isConfigRecord(value)) {
    return {
      ok: false,
      problem: `${describeConfigValue(value)} is not a set of shortcut bindings (expected an object of shortcut id to binding)`,
    };
  }

  const onDesktop = !!getTrinityDesktopBridge()?.isElectron;
  const accepted: { [id: string]: ConfigValue } = {};
  const unknownIds: string[] = [];
  const fixedIds: string[] = [];
  const reservedIds: string[] = [];
  for (const [id, binding] of Object.entries(value)) {
    const def = SHORTCUTS.find((candidate) => candidate.id === id);
    if (!def) {
      unknownIds.push(id);
      continue;
    }
    if (!def.rebindable) {
      fixedIds.push(id);
      continue;
    }
    if (binding === null) {
      accepted[id] = null;
      continue;
    }
    if (!isChord(binding)) {
      return {
        ok: false,
        problem: `the binding for '${id}' is not a keyboard chord (expected accel, alt and shift as true or false, and a key)`,
      };
    }
    if (!hasModifier(binding)) {
      return {
        ok: false,
        problem: `the binding for '${id}' has no Ctrl/Cmd, Alt or Shift, so it would fire while you type`,
      };
    }
    if (!onDesktop && isBrowserReserved(binding)) {
      // Kept, not dropped: the document travels back to the desktop app, where the chord
      // works. Named because here the browser eats it before the page sees it.
      reservedIds.push(id);
    }
    accepted[id] = {
      accel: binding.accel,
      alt: binding.alt,
      shift: binding.shift,
      key: binding.key,
    };
  }

  const warnings: string[] = [];
  if (unknownIds.length > 0) {
    warnings.push(
      `${unknownIds.join(', ')} ${unknownIds.length === 1 ? 'is not a shortcut' : 'are not shortcuts'} this version of Trinity has, so it will not be applied`,
    );
  }
  if (fixedIds.length > 0) {
    warnings.push(
      `${fixedIds.join(', ')} cannot be rebound, so it will not be applied`,
    );
  }
  if (reservedIds.length > 0) {
    warnings.push(
      `the binding for ${reservedIds.join(', ')} is one the browser keeps for itself, so it will only work in the desktop app`,
    );
  }
  return warnings.length > 0
    ? { ok: true, value: accepted, warning: warnings.join('; ') }
    : { ok: true, value: accepted };
}

/**
 * The validated value as the service's own type. Anything that is not a binding is left out
 * rather than asserted away; the service re-filters anyway.
 */
function toBindings(value: ConfigValue): Record<string, Chord | null> {
  const bindings: Record<string, Chord | null> = {};
  if (!isConfigRecord(value)) {
    return bindings;
  }
  for (const [id, binding] of Object.entries(value)) {
    if (binding === null) {
      bindings[id] = null;
    } else if (isChord(binding)) {
      bindings[id] = binding;
    }
  }
  return bindings;
}
