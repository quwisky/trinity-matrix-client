import {
  catchError,
  concatMap,
  defer,
  firstValueFrom,
  from,
  endWith,
  ignoreElements,
  mergeMap,
  Observable,
  of,
  throwError,
  toArray,
} from 'rxjs';

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
  register(
    account: PushAccountRoute,
    descriptor: TrinityPusherDescriptor,
  ): Observable<unknown>;
}
/** Cold, serialized registration operation suitable for a finite user action. */
function registerNow(
  adapter: TrinityPushRegistrationAdapter,
  options: {
    readonly platform: TrinityPushPlatform;
    readonly pushkey: string;
    readonly accounts: readonly PushAccountRoute[];
    readonly gatewayUrl?: string;
  },
): Observable<void> {
  type AccountResult =
    { readonly ok: true } | { readonly ok: false; readonly error: unknown };
  return from(options.accounts).pipe(
    concatMap((account): Observable<AccountResult> =>
      defer(() =>
        adapter.register(
          account,
          createTrinityPusherDescriptor({
            ...options,
            accountRoute: account.route,
          }),
        ),
      ).pipe(
        ignoreElements(),
        endWith({ ok: true } as const),
        catchError((error: unknown) => of({ ok: false, error } as const)),
      ),
    ),
    toArray(),
    mergeMap((results) => {
      const failure = results.find((result) => !result.ok);
      return failure && !failure.ok
        ? throwError(() => failure.error)
        : of(undefined);
    }),
  );
}

export class TrinityPushRegistrationCoordinator {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly adapter: TrinityPushRegistrationAdapter) {}

  register(options: {
    readonly platform: TrinityPushPlatform;
    readonly pushkey: string;
    readonly accounts: readonly PushAccountRoute[];
    readonly gatewayUrl?: string;
  }): Observable<void> {
    return defer(() => {
      const previous = this.queue;
      const task = previous
        .catch(() => undefined)
        .then(() => firstValueFrom(registerNow(this.adapter, options)));
      // Keep the queue alive independently of the caller's subscription. An
      // unsubscribed queued action must not release or cancel an earlier action.
      this.queue = task.then(
        () => undefined,
        () => undefined,
      );
      return from(task);
    });
  }
}
