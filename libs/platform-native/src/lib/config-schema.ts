import {
  InjectionToken,
  makeEnvironmentProviders,
  type EnvironmentProviders,
} from '@angular/core';

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

/**
 * The outcome of checking one pasted value against the setting that owns it.
 *
 * Declared now, implemented in PR 2 — see {@link ConfigEntry.validate}. It is part of the
 * shape because the registry interface is a public commitment (every owning lib implements
 * it), and widening it later would touch every entry in the workspace.
 */
export type ConfigValidation =
  | { readonly ok: true; readonly value: ConfigValue }
  | { readonly ok: false; readonly problem: string };

/**
 * One exported setting: where it appears in the document, which stored key it stands for,
 * and how to read and reset it.
 *
 * **`read` must go through the owning service's public getter and `reset` through its public
 * setter — never through `Preferences`.** The setters write storage *and* move the signal the
 * app renders from, so a reset takes effect in the running app; a raw key write would leave
 * the signal and the store disagreeing until the next launch.
 */
export interface ConfigEntry {
  /**
   * Dotted path in the exported document, grouped by owner (`theme.palette`, not
   * `trinity.palette`). **Part of the committed export format** — renaming one needs a
   * migration keyed off {@link CONFIG_EXPORT_VERSION}.
   *
   * Each owning lib keeps its paths under its own top-level group, which is what makes
   * cross-lib path collisions impossible without a central registry to check against.
   */
  readonly path: string;

  /**
   * The Capacitor `Preferences` key this setting is stored under. Present so the drift
   * guard (`scripts/config-schema-drift.spec.mjs`) can tie an entry back to a classified
   * key — **never used for I/O**. Two entries may share a key when one stored blob holds
   * two independently-edited fields.
   */
  readonly key: string;

  /** The current value, read from the owning service's public getter. */
  readonly read: () => ConfigValue;

  /**
   * Restore the documented default through the owning service's public setter. May be
   * async where the owning setter is. Resets are order-independent: two entries sharing a
   * stored blob must converge on the same result whichever runs first.
   */
  readonly reset: () => void | Promise<void>;

  /** PR 2: apply a validated value through the owning service's public setter. */
  readonly write?: (value: ConfigValue) => void | Promise<void>;

  /** PR 2: check a pasted value before anything is written. */
  readonly validate?: (value: unknown) => ConfigValidation;
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

/** Which library owns a stored key. */
export type ConfigOwner =
  | 'platform-native'
  | 'data-access/gif'
  | 'data-access/notifications'
  | 'data-access/rooms'
  | 'feature/settings';

/**
 * What the config export does with one stored key.
 *
 * `exported` — it appears in the document. `excluded` — it is a real stored preference kept
 * out on purpose. `internal` — it is not a stored preference at all.
 */
export type ConfigKeyRecord =
  | {
      readonly disposition: 'exported';
      readonly key: string;
      readonly owner: ConfigOwner;
    }
  | {
      readonly disposition: 'excluded' | 'internal';
      readonly key: string;
      readonly owner: ConfigOwner;
      readonly reason: string;
    };

/**
 * Every `trinity.*` key the workspace stores, and what the export does with it.
 *
 * The single classification table, and the one thing that has to stay in step as settings
 * are added — which is why it is guarded mechanically rather than by discipline:
 * `scripts/config-schema-drift.spec.mjs` fails when a `trinity.*` literal exists in shipped
 * source and is not listed here, and when a key listed here no longer exists. The issue's
 * own key table had drifted from 13 keys to 24 in the weeks before this was written; that is
 * the evidence the guard exists for.
 *
 * Other stores are excluded wholesale rather than key by key — see
 * {@link CONFIG_EXCLUSION_NOTES}.
 */
export const CONFIG_KEY_LEDGER: readonly ConfigKeyRecord[] = [
  // — theme.service.ts —
  { disposition: 'exported', key: 'trinity.theme', owner: 'platform-native' },
  { disposition: 'exported', key: 'trinity.palette', owner: 'platform-native' },
  {
    disposition: 'exported',
    key: 'trinity.text-scale',
    owner: 'platform-native',
  },
  {
    disposition: 'exported',
    key: 'trinity.code-scale',
    owner: 'platform-native',
  },
  {
    disposition: 'exported',
    key: 'trinity.code-lines',
    owner: 'platform-native',
  },

  // — privacy-settings.service.ts —
  {
    disposition: 'exported',
    key: 'trinity.privacy.send-read-receipts',
    owner: 'platform-native',
  },
  {
    disposition: 'exported',
    key: 'trinity.privacy.link-previews',
    owner: 'platform-native',
  },
  {
    disposition: 'exported',
    key: 'trinity.privacy.link-previews-encrypted',
    owner: 'platform-native',
  },

  // — system-line-settings.service.ts —
  {
    disposition: 'exported',
    key: 'trinity.timeline.show-membership',
    owner: 'platform-native',
  },
  {
    disposition: 'exported',
    key: 'trinity.timeline.show-profile',
    owner: 'platform-native',
  },
  {
    disposition: 'exported',
    key: 'trinity.timeline.show-room-changes',
    owner: 'platform-native',
  },

  // — date-time-format.service.ts —
  {
    disposition: 'exported',
    key: 'trinity.format.time',
    owner: 'platform-native',
  },
  {
    disposition: 'exported',
    key: 'trinity.format.date',
    owner: 'platform-native',
  },

  // — composer-settings.service.ts —
  {
    disposition: 'exported',
    key: 'trinity.composer.show-toolbar',
    owner: 'platform-native',
  },

  // — feature-flags.service.ts —
  {
    disposition: 'exported',
    key: 'trinity.flags.virtual-timeline',
    owner: 'platform-native',
  },

  // — shortcuts/keyboard-shortcuts.service.ts —
  {
    disposition: 'exported',
    key: 'trinity.shortcuts.overrides',
    owner: 'platform-native',
  },

  // — data-access/gif —
  {
    disposition: 'exported',
    key: 'trinity.gif.config',
    owner: 'data-access/gif',
  },

  // — data-access/notifications —
  {
    disposition: 'exported',
    key: 'trinity.push.gateway',
    owner: 'data-access/notifications',
  },
  {
    disposition: 'excluded',
    key: 'trinity.push.applied-app-id',
    owner: 'data-access/notifications',
    reason:
      'Not a preference: the ledger recording which push app id actually reached the ' +
      'homeserver. Importing a foreign value would make the client believe a pusher exists ' +
      'that does not, stranding the real one on the old gateway indefinitely.',
  },

  // — platform-native, excluded —
  {
    disposition: 'excluded',
    key: 'trinity.composer.drafts',
    owner: 'platform-native',
    reason:
      'Unsent message text, not configuration. It must not appear in a document someone ' +
      'pastes into a support thread, and Reset must never destroy it.',
  },

  // — data-access/rooms, excluded —
  {
    disposition: 'excluded',
    key: 'trinity.accounts.mixed',
    owner: 'data-access/rooms',
    reason:
      'A set of signed-in user ids. It cannot transfer — on a device signed into different ' +
      'accounts every id in it is inert — and it puts the same user-id material into a ' +
      'shareable document that excluding `matrix.accounts` was meant to keep out. The mix ' +
      'rebuilds itself as accounts are added.',
  },
  {
    disposition: 'excluded',
    key: 'trinity.spaces.order.default.',
    owner: 'data-access/rooms',
    reason:
      'Per-account: the key is suffixed with a user id, so a portable document would carry ' +
      'an ordering addressed to an account the importing device may not have. Same user-id ' +
      'disclosure as `trinity.accounts.mixed`.',
  },
  {
    disposition: 'excluded',
    key: 'trinity.spaces.order.overrides.',
    owner: 'data-access/rooms',
    reason:
      'Per-account like its sibling, and keyed by space room id on top — an override names ' +
      'spaces the importing account may not have joined.',
  },

  // — feature/settings —
  {
    disposition: 'internal',
    key: 'trinity.notification-sound',
    owner: 'feature/settings',
    reason:
      'Not a stored key at all: a map key standing for the sound switch inside the ' +
      'notifications page optimistic-state map. The preference itself lives in Matrix ' +
      'account data (`eu.qwky.trinity.notification_sound`), which is out of scope.',
  },
];

/**
 * The stores the export never touches at all, and why — the copy the Advanced section
 * shows so the omissions are stated rather than discovered.
 */
export const CONFIG_EXCLUSION_NOTES: readonly {
  readonly what: string;
  readonly reason: string;
}[] = [
  {
    what: 'Your signed-in accounts',
    reason:
      'This is a preferences transfer, not a sign-in transfer. The account registry keys ' +
      'each account by user id and device id, and those are what the stored access token ' +
      'and the per-device crypto store are addressed by — so a copied entry names a token ' +
      'and a crypto store that are not there. Sign in on the new device, then import.',
  },
  {
    what: 'Access tokens and encryption keys',
    reason:
      'They live in secure storage, which nothing here reads. No secret can reach this ' +
      'document.',
  },
  {
    what: 'Unsent message drafts',
    reason:
      'Half-typed messages are not configuration, and this document is meant to be safe to ' +
      'share. Reset to defaults leaves them alone too.',
  },
  {
    what: 'Settings your account carries for you',
    reason:
      'Notification rules and the notification sound live on your homeserver in Matrix ' +
      'account data, so they already follow you to a new device.',
  },
  {
    what: 'Half-finished sign-in state',
    reason:
      'The transient `oidc.*` and `sso.*` values exist only between leaving for a login ' +
      'page and coming back; restoring one elsewhere could only resume a flow that is over.',
  },
];

/** The keys one library is expected to contribute entries for. */
export function exportedKeysFor(owner: ConfigOwner): readonly string[] {
  const keys: string[] = [];
  for (const record of CONFIG_KEY_LEDGER) {
    if (record.disposition === 'exported' && record.owner === owner) {
      keys.push(record.key);
    }
  }
  return keys;
}

/**
 * The export format's version.
 *
 * Bumped when a path is renamed or removed, so an import can tell a document written by an
 * older build from a malformed one — without it the two are indistinguishable.
 */
export const CONFIG_EXPORT_VERSION = 1;

/** The exported document: a versioned envelope around the nested settings. */
export interface ConfigDocument {
  readonly version: number;
  /** ISO-8601, so the file says when it was taken. */
  readonly exportedAt: string;
  readonly settings: ConfigSettings;
}
