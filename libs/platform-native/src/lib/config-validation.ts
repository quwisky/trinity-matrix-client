import type { ConfigAction, ConfigEntry } from './config-entry';

/**
 * The building blocks every {@link ConfigEntry} validator is made of.
 *
 * A pasted document is untrusted input, so each setting is checked against the same guard
 * its owning service uses at startup; these helpers wrap that guard in prose and pair it
 * with the setter, so the check and the write can't drift apart.
 */

const MAX_ECHO = 40;

/**
 * How a rejected value is named to the user: strings are quoted and truncated, everything
 * else is described by its kind, so a message stays one line.
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

/** A plain JSON object: not an array, not null. */
export function isConfigRecord(
  value: unknown,
): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A setting whose value is one of a closed set of ids.
 *
 * `isValid` is the owning service's own guard; `options` is the offered set, and `noun`
 * completes the sentence "'mauve' is not …". `options` is declared once and feeds the
 * rejection message, the schema's `enum` and the editor's completions, so the lists
 * can't drift apart.
 */
export function choiceSetting<T extends string>(spec: {
  readonly isValid: (value: string) => value is T;
  readonly options: readonly string[];
  readonly noun: string;
  readonly set: (value: T) => ConfigAction;
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
    // Re-narrow rather than assert, keeping `as` out of the path that moves the app.
    write: (value) => {
      if (accepts(value)) {
        return spec.set(value);
      }
      return undefined;
    },
  };
}

/** A setting that is on or off. Strict about the type: `'true'` is not `true`. */
export function flagSetting(
  set: (on: boolean) => ConfigAction,
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
        return set(value);
      }
      return undefined;
    },
  };
}

/**
 * A whole number inside a range, such as a pane width in pixels.
 *
 * Clamps rather than rejects an out-of-range number, unlike the other helpers: a bad kind
 * (a string, a list) is a typo the user must see, but a width of 5000 is a number they
 * meant, on a screen the config was not written on. The clamped value is what validation
 * reports, so the change summary shows what will be stored.
 *
 * Non-integers are rounded: a pane is laid out in whole pixels, so storing 341.7 would
 * report one number and apply another.
 */
export function boundedNumberSetting(spec: {
  min: number;
  max: number;
  noun: string;
  set: (value: number) => ConfigAction;
}): Pick<ConfigEntry, 'validate' | 'write' | 'type'> {
  const clamp = (value: number): number =>
    Math.min(spec.max, Math.max(spec.min, Math.round(value)));
  return {
    type: 'number',
    validate: (value) =>
      typeof value === 'number' && Number.isFinite(value)
        ? { ok: true, value: clamp(value) }
        : {
            ok: false,
            problem: `${describeConfigValue(value)} is not ${spec.noun}`,
          },
    write: (value) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return spec.set(clamp(value));
      }
      return undefined;
    },
  };
}

/**
 * A setting the user types. Trimmed on the way in; the value validation reports is the
 * value stored.
 */
export function textSetting(spec: {
  readonly maxLength: number;
  readonly set: (value: string) => ConfigAction;
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
        return spec.set(value.trim());
      }
      return undefined;
    },
  };
}
