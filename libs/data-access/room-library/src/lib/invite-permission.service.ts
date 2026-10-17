import { Injectable, computed, inject, signal } from '@angular/core';
import {
  ClientEvent,
  type MatrixClient,
  type MatrixEvent,
} from 'matrix-js-sdk';
import {
  Observable,
  combineLatest,
  defer,
  from,
  map,
  of,
  switchMap,
  tap,
  throwError,
} from 'rxjs';
import {
  MatrixClientService,
  projectFromClient,
  serverAdvertises,
} from '@trinity/data-access/matrix-client';

/** MSC4380 invite blocking, stable since spec v1.18. */
export const INVITE_PERMISSION_EVENT = 'm.invite_permission_config';
/** The MSC4380 unstable type, which servers advertising only `org.matrix.msc4380` read. */
export const UNSTABLE_INVITE_PERMISSION_EVENT =
  'org.matrix.msc4380.invite_permission_config';

/** One flag for each of the two account-data types. */
interface PerType {
  readonly stable: boolean;
  readonly unstable: boolean;
}

const NO_BLOCK: PerType = { stable: false, unstable: false };

/** The two invite permission types, which the SDK's closed account-data map does not list. */
type InvitePermissionType =
  typeof INVITE_PERMISSION_EVENT | typeof UNSTABLE_INVITE_PERMISSION_EVENT;

interface InvitePermissionAccountData {
  getAccountData(type: InvitePermissionType): MatrixEvent | undefined;
  setAccountData(type: InvitePermissionType, content: object): Promise<unknown>;
}

/**
 * The active account's server-enforced "Who can invite you" setting (MSC4380). Blocking makes
 * the homeserver refuse every invite to this account; it is not a client-side filter.
 */
@Injectable({ providedIn: 'root' })
export class InvitePermissionService {
  private readonly matrix = inject(MatrixClientService);
  private readonly supportByClient = new WeakMap<MatrixClient, PerType>();
  /** Which types the server honours; null while unknown. */
  private readonly support = signal<PerType | null>(null);
  /** Which types currently hold a block. */
  private readonly slots = signal<PerType>(NO_BLOCK, {
    equal: (a, b) => a.stable === b.stable && a.unstable === b.unstable,
  });

  /** Whether the server enforces invite blocking; null until `/versions` answers. */
  readonly supported = computed(() => {
    const support = this.support();
    return support ? support.stable || support.unstable : null;
  });

  /** Whether the server currently turns down every invite to this account. */
  readonly blocked = computed(() => {
    const support = this.support();
    const slots = this.slots();
    return (
      !!support &&
      ((support.stable && slots.stable) || (support.unstable && slots.unstable))
    );
  });

  private readonly projection = projectFromClient({
    id: 'room-library.invite-permission',
    matrix: this.matrix,
    events: [ClientEvent.AccountData],
    rebuild: (client) => {
      this.slots.set(readSlots(client));
      const known = this.supportByClient.get(client);
      this.support.set(known ?? null);
      if (known) return;
      return this.probe(client).pipe(
        tap((support) => {
          if (support && this.projection.client() === client) {
            this.support.set(support);
          }
        }),
        map(() => void 0),
      );
    },
    reset: () => {
      this.support.set(null);
      this.slots.set(NO_BLOCK);
    },
  });

  /** Cold projection lifetime, held by the surface that shows the setting. */
  runProjection(): Observable<void> {
    return this.projection.run();
  }

  /**
   * Block or allow every invite to the active account. Cold. Allowing also clears a block in
   * the unstable slot, which a server advertising both types still honours.
   */
  setBlocked(blocked: boolean): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      const client = this.matrix.instance;
      return this.probe(client).pipe(
        switchMap((support) => {
          if (!support || (!support.stable && !support.unstable)) {
            return throwError(
              () => new Error('This server does not support invite blocking.'),
            );
          }
          if (blocked) {
            return write(
              client,
              support.stable
                ? INVITE_PERMISSION_EVENT
                : UNSTABLE_INVITE_PERMISSION_EVENT,
              { default_action: 'block' },
            );
          }
          const slots = readSlots(client);
          const writes: Observable<void>[] = [];
          if (support.stable) {
            writes.push(write(client, INVITE_PERMISSION_EVENT, {}));
          }
          if (!support.stable || slots.unstable) {
            writes.push(write(client, UNSTABLE_INVITE_PERMISSION_EVENT, {}));
          }
          return combineLatest(writes).pipe(map(() => void 0));
        }),
      );
    });
  }

  private probe(client: MatrixClient): Observable<PerType | null> {
    const known = this.supportByClient.get(client);
    if (known) return of(known);
    return combineLatest([
      serverAdvertises(client, {
        version: 'v1.18',
        unstableFeature: 'org.matrix.msc4380.stable',
      }),
      serverAdvertises(client, { unstableFeature: 'org.matrix.msc4380' }),
    ]).pipe(
      map(([stable, unstable]) => {
        if (stable === null || unstable === null) return null;
        const support = { stable, unstable };
        this.supportByClient.set(client, support);
        return support;
      }),
    );
  }
}

function readSlots(client: MatrixClient): PerType {
  return {
    stable: blocks(client, INVITE_PERMISSION_EVENT),
    unstable: blocks(client, UNSTABLE_INVITE_PERMISSION_EVENT),
  };
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
