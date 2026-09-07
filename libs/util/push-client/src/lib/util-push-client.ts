import { defer, from, defaultIfEmpty, lastValueFrom, Observable } from 'rxjs';

/** Change this one value when the production gateway is provisioned. */
export const DEFAULT_PUSH_GATEWAY_URL =
  'https://push.example.invalid/_matrix/push/v1/notify';
export const TRINITY_PUSH_APP_IDS = {
  android: 'ovh.qwky.trinity.android',
  ios: 'ovh.qwky.trinity.ios',
} as const;
export type TrinityPushPlatform = keyof typeof TRINITY_PUSH_APP_IDS;
export const pushAppId = (platform: TrinityPushPlatform): string =>
  TRINITY_PUSH_APP_IDS[platform];

export interface PushAccountRoute {
  readonly accountId: string;
  readonly route: string;
}
const ROUTE_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;
export function isValidPushAccountRoute(route: unknown): route is string {
  return typeof route === 'string' && ROUTE_PATTERN.test(route);
}
export function resolvePushAccountRoute(
  records: readonly PushAccountRoute[],
  route: string,
): PushAccountRoute | null {
  if (!isValidPushAccountRoute(route)) return null;
  const matches = records.filter((record) => record.route === route);
  return matches.length === 1 ? matches[0] : null;
}
function randomRouteBytes(): Uint8Array {
  const bytes = new Uint8Array(18);
  if (!globalThis.crypto?.getRandomValues)
    throw new Error('Secure randomness is unavailable');
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
export function createPushAccountRoute(
  existing: readonly PushAccountRoute[] = [],
  randomBytes: () => Uint8Array = randomRouteBytes,
): string {
  const used = new Set(existing.map((record) => record.route));
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const route = base64Url(randomBytes());
    if (isValidPushAccountRoute(route) && !used.has(route)) return route;
  }
  throw new Error('Could not allocate a unique push account route');
}

export type TrinityPushPayload =
  TrinityPushEventPayload | TrinityPushCountsPayload;
export interface TrinityPushEventPayload {
  readonly kind: 'event';
  readonly schema: '1';
  readonly accountRoute: string;
  readonly eventId: string;
  readonly roomId: string;
  readonly unread: number;
  readonly missedCalls: number;
  readonly sound: boolean;
  readonly highlight?: boolean;
}
export interface TrinityPushCountsPayload {
  readonly kind: 'counts';
  readonly schema: '1';
  readonly accountRoute: string;
  readonly unread: number;
  readonly missedCalls: number;
  readonly sound: boolean;
  readonly highlight?: boolean;
}
function requiredString(
  data: Record<string, unknown>,
  key: string,
): string | null {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
function decimal(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
    return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function booleanValue(
  data: Record<string, unknown>,
  key: string,
  required: boolean,
): boolean | undefined | null {
  const value = data[key];
  if (value === undefined && !required) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}
/** Parse the gateway's string-only v1 data payload; malformed input returns null. */
export function parseTrinityPushPayload(
  input: unknown,
): TrinityPushPayload | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const data = input as Record<string, unknown>;
  if (
    data['schema'] !== '1' ||
    (data['kind'] !== 'event' && data['kind'] !== 'counts')
  )
    return null;
  const accountRoute = requiredString(data, 'trinity_account_id');
  const unread = decimal(data, 'unread');
  const missedCalls = decimal(data, 'missed_calls');
  const sound = booleanValue(data, 'sound', true);
  const highlight = booleanValue(data, 'highlight', false);
  if (
    !accountRoute ||
    !isValidPushAccountRoute(accountRoute) ||
    unread === null ||
    missedCalls === null ||
    typeof sound !== 'boolean' ||
    highlight === null
  )
    return null;
  const common = {
    schema: '1' as const,
    accountRoute,
    unread,
    missedCalls,
    sound,
  };
  if (data['kind'] === 'counts')
    return {
      ...common,
      kind: 'counts',
      ...(highlight === undefined ? {} : { highlight }),
    };
  const eventId = requiredString(data, 'event_id');
  const roomId = requiredString(data, 'room_id');
  if (!eventId || !roomId) return null;
  return {
    ...common,
    kind: 'event',
    eventId,
    roomId,
    ...(highlight === undefined ? {} : { highlight }),
  };
}

export interface TrinityPusherDescriptor {
  readonly kind: 'http';
  readonly appId: string;
  readonly pushkey: string;
  readonly url: string;
  readonly append: true;
  readonly deviceDisplayName?: string;
  readonly data: {
    readonly format: 'event_id_only';
    readonly trinity_account_id: string;
    readonly trinity_push_version: '1';
  };
}
export function createTrinityPusherDescriptor(options: {
  readonly platform: TrinityPushPlatform;
  readonly pushkey: string;
  readonly accountRoute: string;
  readonly gatewayUrl?: string;
}): TrinityPusherDescriptor {
  if (!options.pushkey || !isValidPushAccountRoute(options.accountRoute))
    throw new Error('A pushkey and valid account route are required');
  return {
    kind: 'http',
    appId: pushAppId(options.platform),
    pushkey: options.pushkey,
    url: options.gatewayUrl ?? DEFAULT_PUSH_GATEWAY_URL,
    append: true,
    data: {
      format: 'event_id_only',
      trinity_account_id: options.accountRoute,
      trinity_push_version: '1',
    },
  };
}
export interface TrinityPushRegistrationAdapter {
  load(accountId: string): Observable<TrinityPushRegistrationState | null>;
  save(
    accountId: string,
    state: TrinityPushRegistrationState | null,
  ): Observable<unknown>;
  list(accountId: string): Observable<TrinityPushRemotePusher[]>;
  register(
    account: PushAccountRoute,
    descriptor: TrinityPusherDescriptor,
  ): Observable<unknown>;
  remove(accountId: string, identity: PushPusherIdentity): Observable<unknown>;
}

export interface PushPusherIdentity {
  readonly appId: string;
  readonly pushkey: string;
}
export interface TrinityPushRegistrationState {
  readonly version: 1;
  readonly identities: readonly PushPusherIdentity[];
  readonly applied?: TrinityPusherDescriptor;
}
export interface TrinityPushRemotePusher extends PushPusherIdentity {
  readonly kind: string;
  readonly url: string;
  readonly format?: string;
  readonly version?: string;
  readonly deviceDisplayName: string;
  readonly appDisplayName?: string;
  readonly accountRoute?: string;
}
export type TrinityPushRegistrationFailureCode =
  | 'load-failed'
  | 'save-failed'
  | 'list-failed'
  | 'remove-failed'
  | 'register-failed'
  | 'readback-failed';
export interface TrinityPushRegistrationFailure {
  readonly accountId: string;
  readonly code: TrinityPushRegistrationFailureCode;
}
export interface TrinityPushRegistrationReport {
  readonly applied: readonly string[];
  readonly failed: readonly TrinityPushRegistrationFailure[];
}
export interface TrinityPushRegistrationOptions {
  readonly platform: TrinityPushPlatform;
  readonly pushkey: string;
  readonly gatewayUrl?: string;
  readonly legacyAppIds?: readonly string[];
}

const identityKey = (identity: PushPusherIdentity): string =>
  JSON.stringify([identity.appId, identity.pushkey]);
const uniqueIdentities = (
  identities: readonly PushPusherIdentity[],
): PushPusherIdentity[] => {
  const seen = new Set<string>();
  return identities.filter((identity) => {
    const key = identityKey(identity);
    if (!identity.appId || !identity.pushkey || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
const isPushPusherIdentity = (value: unknown): value is PushPusherIdentity =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as { appId?: unknown }).appId === 'string' &&
  (value as { appId: string }).appId.length > 0 &&
  typeof (value as { pushkey?: unknown }).pushkey === 'string' &&
  (value as { pushkey: string }).pushkey.length > 0;
export const isTrinityPushRegistrationState = (
  value: unknown,
): value is TrinityPushRegistrationState =>
  !!value &&
  typeof value === 'object' &&
  (value as { version?: unknown }).version === 1 &&
  Array.isArray((value as { identities?: unknown }).identities) &&
  (value as { identities: unknown[] }).identities.every(isPushPusherIdentity) &&
  ((value as { applied?: unknown }).applied === undefined ||
    isTrinityPusherDescriptor((value as { applied: unknown }).applied));
const isTrinityPusherDescriptor = (
  value: unknown,
): value is TrinityPusherDescriptor => {
  if (!value || typeof value !== 'object') return false;
  const descriptor = value as Partial<TrinityPusherDescriptor>;
  return (
    descriptor.kind === 'http' &&
    typeof descriptor.appId === 'string' &&
    descriptor.appId.length > 0 &&
    typeof descriptor.pushkey === 'string' &&
    descriptor.pushkey.length > 0 &&
    typeof descriptor.url === 'string' &&
    descriptor.url.length > 0 &&
    descriptor.append === true &&
    (descriptor.deviceDisplayName === undefined ||
      typeof descriptor.deviceDisplayName === 'string') &&
    !!descriptor.data &&
    descriptor.data.format === 'event_id_only' &&
    typeof descriptor.data.trinity_account_id === 'string' &&
    isValidPushAccountRoute(descriptor.data.trinity_account_id) &&
    descriptor.data.trinity_push_version === '1'
  );
};
export const normalizeTrinityPushRegistrationState = (
  state: TrinityPushRegistrationState | null | unknown,
): TrinityPushRegistrationState => ({
  // Non-null corrupt storage is rejected by the coordinator through this guard.
  version: 1,
  identities: uniqueIdentities(
    isTrinityPushRegistrationState(state) ? state.identities : [],
  ),
  ...(isTrinityPushRegistrationState(state) && state.applied
    ? { applied: (state as { applied: TrinityPusherDescriptor }).applied }
    : {}),
});
const observe = <T>(source: Observable<T>): Promise<T | undefined> =>
  lastValueFrom(source.pipe(defaultIfEmpty(undefined)));

type AccountResult =
  | { readonly accountId: string; readonly ok: true }
  | {
      readonly accountId: string;
      readonly ok: false;
      readonly code: TrinityPushRegistrationFailureCode;
    };

export class TrinityPushRegistrationCoordinator {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly adapter: TrinityPushRegistrationAdapter) {}

  register(
    options: TrinityPushRegistrationOptions & {
      readonly accounts: readonly (PushAccountRoute & {
        readonly deviceDisplayName: string;
      })[];
    },
  ): Observable<TrinityPushRegistrationReport> {
    return this.enqueue(() => this.registerNow(options));
  }

  unregister(
    options: Pick<
      TrinityPushRegistrationOptions,
      'platform' | 'legacyAppIds'
    > & {
      readonly accounts: readonly Readonly<{
        accountId: string;
        route?: string;
        deviceDisplayName: string;
      }>[];
    },
  ): Observable<TrinityPushRegistrationReport> {
    return this.enqueue(() => this.unregisterNow(options));
  }

  private enqueue(
    action: () => Promise<TrinityPushRegistrationReport>,
  ): Observable<TrinityPushRegistrationReport> {
    return defer(() => {
      const previous = this.queue;
      const task = previous.catch(() => undefined).then(action);
      this.queue = task.then(
        () => undefined,
        () => undefined,
      );
      // Unsubscribing cannot cancel the queued promise or release the queue.
      return from(task);
    });
  }

  private async registerNow(
    options: TrinityPushRegistrationOptions & {
      readonly accounts: readonly (PushAccountRoute & {
        readonly deviceDisplayName: string;
      })[];
    },
  ): Promise<TrinityPushRegistrationReport> {
    const results: AccountResult[] = [];
    for (const account of options.accounts) {
      results.push(await this.registerAccount(account, options));
    }
    return report(results);
  }

  private async registerAccount(
    account: PushAccountRoute & { readonly deviceDisplayName: string },
    options: TrinityPushRegistrationOptions,
  ): Promise<AccountResult> {
    const desired = {
      appId: pushAppId(options.platform),
      pushkey: options.pushkey,
    };
    const descriptor = {
      ...createTrinityPusherDescriptor({
        ...options,
        accountRoute: account.route,
      }),
      deviceDisplayName: account.deviceDisplayName,
    };
    let state: TrinityPushRegistrationState;
    try {
      const stored = await observe(this.adapter.load(account.accountId));
      if (
        stored !== null &&
        stored !== undefined &&
        !isTrinityPushRegistrationState(stored)
      )
        return failure(account.accountId, 'load-failed');
      state = normalizeTrinityPushRegistrationState(stored);
    } catch {
      return failure(account.accountId, 'load-failed');
    }
    let remote: TrinityPushRemotePusher[];
    try {
      remote = (await observe(this.adapter.list(account.accountId))) ?? [];
    } catch {
      return failure(account.accountId, 'list-failed');
    }
    const ownedAppIds = new Set([
      desired.appId,
      ...(options.legacyAppIds ?? []),
    ]);
    // A persisted identity is authoritative. Remote discovery is only a supplement
    // for this explicitly owned app-id set and this installation's display name.
    const stale = uniqueIdentities([
      ...state.identities,
      ...remote.filter(
        (row) =>
          ownedAppIds.has(row.appId) &&
          row.deviceDisplayName.trim() !== '' &&
          row.deviceDisplayName.trim() === account.deviceDisplayName.trim() &&
          (row.appId === desired.appId
            ? row.accountRoute === account.route
            : row.appDisplayName === 'Trinity'),
      ),
    ]).filter((identity) => identityKey(identity) !== identityKey(desired));
    const retained: PushPusherIdentity[] = [desired];
    let removalFailed = false;
    try {
      await observe(
        this.adapter.save(account.accountId, {
          version: 1,
          identities: [...stale, desired],
        }),
      );
    } catch {
      return failure(account.accountId, 'save-failed');
    }
    for (const identity of stale) {
      try {
        await observe(this.adapter.remove(account.accountId, identity));
      } catch {
        removalFailed = true;
        retained.push(identity);
      }
    }
    try {
      remote = (await observe(this.adapter.list(account.accountId))) ?? [];
    } catch {
      return failure(account.accountId, 'readback-failed');
    }
    const staleStillPresent = remote.filter((row) =>
      stale.some((identity) => identityKey(identity) === identityKey(row)),
    );
    for (const row of staleStillPresent) {
      if (
        !retained.some((identity) => identityKey(identity) === identityKey(row))
      )
        retained.push(row);
    }
    if (removalFailed) {
      try {
        await observe(
          this.adapter.save(account.accountId, {
            version: 1,
            identities: retained,
          }),
        );
      } catch {
        return failure(account.accountId, 'save-failed');
      }
      return failure(account.accountId, 'remove-failed');
    }
    if (staleStillPresent.length) {
      try {
        await observe(
          this.adapter.save(account.accountId, {
            version: 1,
            identities: [desired, ...staleStillPresent],
          }),
        );
      } catch {
        return failure(account.accountId, 'save-failed');
      }
      return failure(account.accountId, 'remove-failed');
    }
    try {
      await observe(this.adapter.register(account, descriptor));
    } catch {
      return failure(account.accountId, 'register-failed');
    }
    let confirmed: TrinityPushRemotePusher[];
    try {
      confirmed = (await observe(this.adapter.list(account.accountId))) ?? [];
    } catch {
      return failure(account.accountId, 'readback-failed');
    }
    if (
      !confirmed.some(
        (row) =>
          identityKey(row) === identityKey(desired) &&
          row.kind === 'http' &&
          row.url === descriptor.url &&
          row.format === 'event_id_only' &&
          row.version === '1' &&
          row.deviceDisplayName.trim() ===
            descriptor.deviceDisplayName?.trim() &&
          row.accountRoute === account.route,
      )
    )
      return failure(account.accountId, 'readback-failed');
    const stillPresent = confirmed.filter((row) =>
      stale.some((identity) => identityKey(identity) === identityKey(row)),
    );
    try {
      await observe(
        this.adapter.save(account.accountId, {
          version: 1,
          identities: [desired, ...stillPresent],
          ...(stillPresent.length === 0 ? { applied: descriptor } : {}),
        }),
      );
    } catch {
      return failure(account.accountId, 'save-failed');
    }
    return stillPresent.length
      ? failure(account.accountId, 'remove-failed')
      : { accountId: account.accountId, ok: true };
  }

  private async unregisterNow(
    options: Pick<
      TrinityPushRegistrationOptions,
      'platform' | 'legacyAppIds'
    > & {
      readonly accounts: readonly Readonly<{
        accountId: string;
        route?: string;
        deviceDisplayName: string;
      }>[];
    },
  ): Promise<TrinityPushRegistrationReport> {
    const results: AccountResult[] = [];
    for (const account of options.accounts) {
      results.push(await this.unregisterAccount(account, options));
    }
    return report(results);
  }

  private async unregisterAccount(
    account: Readonly<{
      accountId: string;
      route?: string;
      deviceDisplayName: string;
    }>,
    options: Pick<TrinityPushRegistrationOptions, 'platform' | 'legacyAppIds'>,
  ): Promise<AccountResult> {
    let state: TrinityPushRegistrationState;
    try {
      const stored = await observe(this.adapter.load(account.accountId));
      if (
        stored !== null &&
        stored !== undefined &&
        !isTrinityPushRegistrationState(stored)
      )
        return failure(account.accountId, 'load-failed');
      state = normalizeTrinityPushRegistrationState(stored);
    } catch {
      return failure(account.accountId, 'load-failed');
    }
    let remote: TrinityPushRemotePusher[];
    try {
      remote = (await observe(this.adapter.list(account.accountId))) ?? [];
    } catch {
      return failure(account.accountId, 'list-failed');
    }
    const appIds = new Set([
      pushAppId(options.platform),
      ...(options.legacyAppIds ?? []),
    ]);
    const candidates = uniqueIdentities([
      ...state.identities,
      ...remote.filter(
        (row) =>
          (row.appId === pushAppId(options.platform)
            ? account.route !== undefined && row.accountRoute === account.route
            : appIds.has(row.appId) && row.appDisplayName === 'Trinity') &&
          row.deviceDisplayName.trim() !== '' &&
          row.deviceDisplayName.trim() === account.deviceDisplayName.trim(),
      ),
    ]);
    try {
      await observe(
        this.adapter.save(account.accountId, {
          version: 1,
          identities: candidates,
        }),
      );
    } catch {
      return failure(account.accountId, 'save-failed');
    }
    const failed: PushPusherIdentity[] = [];
    for (const identity of candidates) {
      try {
        await observe(this.adapter.remove(account.accountId, identity));
      } catch {
        failed.push(identity);
      }
    }
    try {
      remote = (await observe(this.adapter.list(account.accountId))) ?? [];
    } catch {
      return failure(account.accountId, 'readback-failed');
    }
    const remaining = uniqueIdentities([
      ...failed,
      ...remote.filter((row) =>
        candidates.some(
          (identity) => identityKey(identity) === identityKey(row),
        ),
      ),
    ]);
    try {
      await observe(
        this.adapter.save(
          account.accountId,
          remaining.length ? { version: 1, identities: remaining } : null,
        ),
      );
    } catch {
      return failure(account.accountId, 'save-failed');
    }
    return remaining.length
      ? failure(account.accountId, 'remove-failed')
      : { accountId: account.accountId, ok: true };
  }
}

const failure = (
  accountId: string,
  code: TrinityPushRegistrationFailureCode,
): AccountResult => ({ accountId, ok: false, code });
const report = (
  results: readonly AccountResult[],
): TrinityPushRegistrationReport => ({
  applied: results
    .filter((result) => result.ok)
    .map((result) => result.accountId),
  failed: results
    .filter(
      (result): result is Extract<AccountResult, { ok: false }> => !result.ok,
    )
    .map(({ accountId, code }) => ({ accountId, code })),
});
