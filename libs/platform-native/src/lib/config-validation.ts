import type { ConfigEntry } from './config-schema';

/**
 * The building blocks every {@link ConfigEntry} validator is made of.
 *
 * A pasted document is untrusted input, so each setting is checked against the same guard
 * its owning service already uses at startup — these helpers only wrap that guard in prose
 * and pair it with the setter, so the check and the write can never drift apart. Exported
 * from the lib because the entries live in three libraries and the wording of a rejection
 * is part of the feature.
 */

/** How much of a pasted string is echoed back in a problem message. */
const MAX_ECHO = 40;

/**
 * How a rejected value is named to the user.
 *
 * Strings are quoted and truncated (someone pastes a whole file into one field); everything
 * else is described by its kind rather than dumped, so a message stays one readable line.
 */
export function describeConfigValue(value: unknown): string {
  if (typeof value === 'string') {
    const shown =
      value.length > MAX_ECHO ? `${value.slice(0, MAX_ECHO)}…` : value;
    return `'${shown}'`;
  }
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'nothing';
  }
  if (Array.isArray(value)) {
    return 'a list';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/** `['system', 'light', 'dark']` → `system, light or dark`. */
export function listOptions(options: readonly string[]): string {
  if (options.length <= 1) {
    return options.join('');
  }
  const last = options[options.length - 1];
  return `${options.slice(0, -1).join(', ')} or ${last}`;
}

/** A plain JSON object — not an array, not null. */
export function isConfigRecord(
  value: unknown,
): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A setting whose value is one of a closed set of ids.
 *
 * `isValid` is the owning service's own guard, so the imported value is held to the same
 * standard as the stored one; `options` is the offered set, and `noun` completes the
 * sentence "'mauve' is not …".
 *
 * `options` is declared here once and reaches three places from this one call: the rejection
 * message, the schema's `enum`, and the editor's completion list. The alternative — a list
 * for the message and a second for the schema — is the drift this whole feature exists to
 * stop, one level down.
 */
export function choiceSetting<T extends string>(spec: {
  readonly isValid: (value: string) => value is T;
  readonly options: readonly string[];
  readonly noun: string;
  readonly set: (value: T) => void;
}): Pick<ConfigEntry, 'validate' | 'write' | 'type' | 'choices'> {
  const accepts = (value: unknown): value is T =>
    typeof value === 'string' && spec.isValid(value);
  return {
    type: 'string',
    choices: spec.options,
    validate: (value) =>
      accepts(value)
        ? { ok: true, value }
        : {
            ok: false,
            problem: `${describeConfigValue(value)} is not ${spec.noun} (expected ${listOptions(spec.options)})`,
          },
    // Re-narrowing rather than asserting: `write` is only ever called with a value
    // `validate` accepted, so the guard costs one comparison and keeps `as` out of the
    // path that actually moves the app.
    write: (value) => {
      if (accepts(value)) {
        spec.set(value);
      }
    },
  };
}

/** A setting that is on or off. Strict about the type: `'true'` is not `true`. */
export function flagSetting(
  set: (on: boolean) => void,
): Pick<ConfigEntry, 'validate' | 'write' | 'type'> {
  return {
    type: 'boolean',
    validate: (value) =>
      typeof value === 'boolean'
        ? { ok: true, value }
        : {
            ok: false,
            problem: `${describeConfigValue(value)} is not true or false`,
          },
    write: (value) => {
      if (typeof value === 'boolean') {
        set(value);
      }
    },
  };
}

/**
 * A setting the user types. Trimmed on the way in — the value validation reports is the
 * value that gets stored, so the change summary cannot promise something else.
 */
export function textSetting(spec: {
  readonly maxLength: number;
  readonly set: (value: string) => void;
}): Pick<ConfigEntry, 'validate' | 'write' | 'type'> {
  return {
    type: 'string',
    validate: (value) => {
      if (typeof value !== 'string') {
        return {
          ok: false,
          problem: `${describeConfigValue(value)} is not text`,
        };
      }
      const trimmed = value.trim();
      if (trimmed.length > spec.maxLength) {
        return {
          ok: false,
          problem: `this is longer than ${spec.maxLength} characters, so it is not a value this setting takes`,
        };
      }
      return { ok: true, value: trimmed };
    },
    write: (value) => {
      if (typeof value === 'string') {
        spec.set(value.trim());
      }
    },
  };
}
