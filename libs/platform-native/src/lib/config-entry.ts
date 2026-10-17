import {
  InjectionToken,
  makeEnvironmentProviders,
  type EnvironmentProviders,
} from '@angular/core';
import type { Observable } from 'rxjs';

/**
 * A value as it appears in the exported document — plain JSON, nothing else. Keeping this
 * closed (rather than `unknown`) is what makes the envelope round-trippable: anything a
 * `read()` returns must survive `JSON.stringify` and come back identical.
 */
export type ConfigValue =
  | string
  | number
  | boolean
  | null
  | readonly ConfigValue[]
  | { readonly [key: string]: ConfigValue };

/** The `settings` half of the envelope: the entries' values nested by their dotted paths. */
export type ConfigSettings = { readonly [key: string]: ConfigValue };
export type ConfigAction = void | Promise<void> | Observable<unknown>;

/** Finite caller observation; an already-started setter remains owned after this deadline. */
export const CONFIG_RESET_OBSERVATION_BUDGET_MS = 10_000;

export type ConfigResetEntryOutcome =
  | {
      readonly entry: string;
      readonly status: 'queued' | 'in-progress' | 'completed';
    }
  | {
      readonly entry: string;
      readonly status: 'failed';
      readonly diagnostic: { readonly code: 'config-reset-entry-failed' };
    };

/** Value-free progress for one reset attempt across the exact exported catalogue. */
export interface ConfigResetLedger {
  readonly attempt: number;
  readonly status: 'running' | 'settled';
  readonly entries: readonly ConfigResetEntryOutcome[];
}

export type ConfigResetOutcome =
  | {
      readonly kind: 'completed';
      readonly attempt: number;
      readonly entries: readonly ConfigResetEntryOutcome[];
    }
  | {
      readonly kind: 'partial';
      readonly attempt: number;
      readonly entries: readonly ConfigResetEntryOutcome[];
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'stale-attempt' | 'nothing-to-retry';
    };

/**
 * A JSON type name, spelled exactly as JSON Schema spells it.
 *
 * The vocabulary is deliberately JSON's and not TypeScript's: this is what a setting looks
 * like *in the document*, which is the only thing the editor and the published schema can
 * see. A setting whose value may be absent is expressed by listing `'null'`, never by an
 * optional type.
 */
export type ConfigJsonType =
  'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

/**
 * The outcome of checking one pasted value against the setting that owns it.
 *
 * `value` is the value as it will actually be *stored*, which may differ from what was
 * pasted — a gateway URL arrives normalised, an API key trimmed — so the change summary
 * names what the app will end up holding rather than what was typed.
 *
 * `problem` is prose about the value alone; the plan prefixes it with the offending path,
 * so a validator never has to know where in the document it sits.
 *
 * `warning` is for a value that is accepted and applied but will not *do* anything on this
 * device — a push gateway on a platform with no push, a shortcut id this build does not
 * have. Decision 4 on the issue: warn and proceed, naming what will not apply here, rather
 * than silently filtering.
 */
export type ConfigValidation =
  | {
      readonly ok: true;
      readonly value: ConfigValue;
      readonly warning?: string;
    }
  | { readonly ok: false; readonly problem: string };

/**
 * One exported setting: where it appears in the document, which stored key it stands for,
 * and how to read and reset it.
 *
 * **`read` must use the owning read model and `reset` its public command — never
 * `Preferences`.** The command writes storage *and* moves the committed signal the app renders
 * from, so a reset takes effect in the running app; a raw key write would leave state and storage
 * disagreeing until the next launch.
 */
export interface ConfigEntry {
  /**
   * Dotted path in the exported document, grouped by owner (`appearance.theme`, not
   * `trinity.appearance.theme`). **Part of the committed export format** — renaming one needs a
   * migration keyed off {@link CONFIG_EXPORT_VERSION}.
   *
   * Each owning lib keeps its paths under its own top-level group; `AppConfigService`
   * enforces the rest, rejecting a registry whose paths repeat or overlap.
   */
  readonly path: string;

  /**
   * The Capacitor `Preferences` key this setting is stored under — **never used for I/O**.
   *
   * Present so an entry can be tied back to its classification: each owning lib's spec
   * compares its registered keys against {@link exportedKeysFor}, which is what fails when
   * a key is classified `exported` in {@link CONFIG_KEY_LEDGER} and no entry reads it (or
   * the reverse). The drift guard in `scripts/config-schema-drift.spec.mjs` answers a
   * different question — whether a stored key is classified at all.
   *
   * Two entries may share a key when one stored blob holds two independently-edited fields.
   */
  readonly key: string;

  /**
   * What this setting is, in one line, in the words the user would use.
   *
   * **Required**, so a setting cannot join the document without saying what it is. It is the
   * only description there will ever be: it is the hover text in the editor, the
   * `description` in {@link configJsonSchema}, and the note beside a completion — one
   * sentence, no trailing context, because all three render it as a single line.
   */
  readonly description: string;

  /**
   * The JSON type this setting's value takes in the document — one name, or the list of
   * names when more than one shape is legitimate (the push gateway is an object *or* null).
   *
   * Supplied by {@link choiceSetting}/{@link flagSetting}/{@link textSetting} for the
   * settings built from them, so the type the schema publishes is the one the validator
   * actually enforces rather than a second, hand-copied claim about it.
   */
  readonly type: ConfigJsonType | readonly ConfigJsonType[];

  /**
   * The complete set of accepted values, when the setting is a closed choice — and absent
   * when it is not, which is what tells the editor to offer a completion list rather than a
   * free-text field.
   *
   * Declared **once**, in the call to {@link choiceSetting} that also builds the validator,
   * so the published enum and the accepted set are the same array. That they stay the same
   * is not left to reading: `configSchemaDrift` runs every listed value back through
   * `validate` and reports any that the setting would actually refuse.
   */
  readonly choices?: readonly string[];

  /** The current value, read from the owning service's public getter. */
  readonly read: () => ConfigValue;

  /**
   * Restore the documented default through the owning service's public setter. May be
   * async where the owning setter is. Resets are order-independent: two entries sharing a
   * stored blob must converge on the same result whichever runs first.
   */
  readonly reset: () => ConfigAction;

  /**
   * Apply a validated value through the owning service's public setter — same rule as
   * {@link reset}, and for the same reason: an applied document has to move the running app.
   *
   * Only ever called with a value {@link validate} accepted, so it may narrow with the same
   * guard and ignore anything else. **Required**, not optional: an entry that can be
   * exported but not imported would make the document silently asymmetric, and the whole
   * point of the format is that what comes out goes back in.
   */
  readonly write: (value: ConfigValue) => ConfigAction;

  /**
   * Check a pasted value before anything anywhere is written. This is the boundary — the
   * owning services trust their own setters, so a document only ever reaches them through
   * here.
   *
   * Reuses the owning service's guard wherever one exists, so an imported value is held to
   * exactly the standard a stored one is.
   */
  readonly validate: (value: unknown) => ConfigValidation;
}

/**
 * The exported settings, contributed one group per owning library.
 *
 * `multi: true`, so each lib registers its own settings without `libs/feature/settings`
 * importing across a boundary it may not cross, and without `platform-native` importing
 * `data-access` (which the Nx rules forbid in that direction). Modelled on
 * `ENCRYPTION_DIALOG_COMPONENTS`: declared in the shared kernel, wired in `main.ts`, and
 * injected `{ optional: true }` so the lib still works with no app wiring.
 */
export const APP_CONFIG_ENTRIES = new InjectionToken<
  readonly (readonly ConfigEntry[])[]
>('APP_CONFIG_ENTRIES');

/** Register one library's exported settings. Call the result from `main.ts`. */
export function provideConfigEntries(
  useFactory: () => readonly ConfigEntry[],
): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: APP_CONFIG_ENTRIES, multi: true, useFactory },
  ]);
}

/**
 * The export format's version.
 *
 * Bumped when a path is renamed or removed, so an import can tell a document written by an
 * older build from a malformed one — without it the two are indistinguishable.
 */
// Version 3 records removal of the legacy composer toolbar preferences; version 4 the
// push gateway override (`push.gateway`).
export const CONFIG_EXPORT_VERSION = 4;

/** The exported document: a versioned envelope around the nested settings. */
export interface ConfigDocument {
  readonly version: number;
  /** ISO-8601, so the file says when it was taken. */
  readonly exportedAt: string;
  readonly settings: ConfigSettings;
}
