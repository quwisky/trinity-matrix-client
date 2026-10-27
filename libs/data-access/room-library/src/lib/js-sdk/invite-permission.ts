import {
  ClientEvent,
  type MatrixClient,
  type MatrixEvent,
} from 'matrix-js-sdk';
import {
  Observable,
  combineLatest,
  concat,
  distinctUntilChanged,
  from,
  map,
  merge,
  of,
  startWith,
  switchMap,
  take,
  throwError,
} from 'rxjs';
import { serverAdvertises } from '@trinity/data-access/matrix-client';
import { plainEqual } from '@trinity/util/matrix';
import type { InviteBlocking } from '../room-list-engine';

/** MSC4380 invite blocking, stable since spec v1.18. */
const INVITE_PERMISSION_EVENT = 'm.invite_permission_config';
/** The MSC4380 unstable type, which servers advertising only `org.matrix.msc4380` read. */
const UNSTABLE_INVITE_PERMISSION_EVENT =
  'org.matrix.msc4380.invite_permission_config';

/** The two invite permission types, which the SDK's closed account-data map does not list. */
type InvitePermissionType =
  typeof INVITE_PERMISSION_EVENT | typeof UNSTABLE_INVITE_PERMISSION_EVENT;

const TYPES: readonly string[] = [
  INVITE_PERMISSION_EVENT,
  UNSTABLE_INVITE_PERMISSION_EVENT,
];

interface InvitePermissionAccountData {
  getAccountData(type: InvitePermissionType): MatrixEvent | undefined;
  setAccountData(type: InvitePermissionType, content: object): Promise<unknown>;
}

/** One flag for each of the two account-data types. */
interface PerType {
  readonly stable: boolean;
  readonly unstable: boolean;
}

export const NO_INVITE_BLOCKING: InviteBlocking = {
  supported: false,
  blocked: false,
};

/** Which types the server honours; null when `/versions` fails. */
function support(client: MatrixClient): Observable<PerType | null> {
  return combineLatest([
    serverAdvertises(client, {
      version: 'v1.18',
      unstableFeature: 'org.matrix.msc4380.stable',
    }),
    serverAdvertises(client, { unstableFeature: 'org.matrix.msc4380' }),
  ]).pipe(
    map(([stable, unstable]) =>
      stable === null || unstable === null ? null : { stable, unstable },
    ),
  );
}

const honoured = (types: PerType | null): types is PerType =>
  !!types && (types.stable || types.unstable);

/**
 * Unsupported on subscribe, then the server's answer; again on the two account-data types and
 * whenever `written` fires. A failed `/versions` check is asked again on the next such change.
 */
export function inviteBlockingOf(
  client: MatrixClient,
  written: Observable<unknown>,
): Observable<InviteBlocking> {
  const changed = new Observable<void>((subscriber) => {
    const onAccountData = (event: MatrixEvent): void => {
      if (TYPES.includes(event.getType())) subscriber.next();
    };
    client.on(ClientEvent.AccountData, onAccountData);
    return () => client.off(ClientEvent.AccountData, onAccountData);
  });
  const check = (): Observable<PerType | null> =>
    support(client).pipe(
      switchMap((types) =>
        types
          ? of(types)
          : concat(
              of(null),
              merge(changed, written).pipe(take(1), switchMap(check)),
            ),
      ),
    );
  return concat(of(null), check()).pipe(
    switchMap((types) =>
      merge(changed, written).pipe(
        startWith(undefined),
        map((): InviteBlocking => {
          if (!honoured(types)) return NO_INVITE_BLOCKING;
          const blocked =
            (types.stable && blocks(client, INVITE_PERMISSION_EVENT)) ||
            (types.unstable &&
              blocks(client, UNSTABLE_INVITE_PERMISSION_EVENT));
          return { supported: true, blocked };
        }),
      ),
    ),
    distinctUntilChanged<InviteBlocking>(plainEqual),
  );
}

/**
 * Blocks or allows every invite. Allowing also clears a block in the unstable slot, which a
 * server advertising both types honours.
 */
export function writeInviteBlocking(
  client: MatrixClient,
  blocked: boolean,
): Observable<void> {
  return support(client).pipe(
    switchMap((types) => {
      if (!honoured(types)) {
        return throwError(
          () => new Error('This server does not support invite blocking.'),
        );
      }
      if (blocked) {
        return write(
          client,
          types.stable
            ? INVITE_PERMISSION_EVENT
            : UNSTABLE_INVITE_PERMISSION_EVENT,
          { default_action: 'block' },
        );
      }
      const writes: Observable<void>[] = [];
      if (types.stable) writes.push(write(client, INVITE_PERMISSION_EVENT, {}));
      if (!types.stable || blocks(client, UNSTABLE_INVITE_PERMISSION_EVENT)) {
        writes.push(write(client, UNSTABLE_INVITE_PERMISSION_EVENT, {}));
      }
      return combineLatest(writes).pipe(map(() => void 0));
    }),
  );
}

function accountData(client: MatrixClient): InvitePermissionAccountData {
  return client as unknown as InvitePermissionAccountData;
}

function blocks(client: MatrixClient, type: InvitePermissionType): boolean {
  const content: unknown = accountData(client)
    .getAccountData(type)
    ?.getContent();
  return (
    typeof content === 'object' &&
    content !== null &&
    (content as { default_action?: unknown }).default_action === 'block'
  );
}

function write(
  client: MatrixClient,
  type: InvitePermissionType,
  content: object,
): Observable<void> {
  return from(accountData(client).setAccountData(type, content)).pipe(
    map(() => void 0),
  );
}
