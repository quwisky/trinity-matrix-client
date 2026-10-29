import {
  Injectable,
  InjectionToken,
  Injector,
  computed,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  Observable,
  catchError,
  concat,
  defer,
  filter,
  from,
  ignoreElements,
  map,
  merge,
  of,
  shareReplay,
  switchMap,
  take,
  throwError,
  timeout,
} from 'rxjs';
import {
  SessionStateService,
  TrustCryptoPort,
} from '@trinity/data-access/matrix-client';
import {
  PreferenceStoreService,
  definePreference,
  type PreferenceContext,
  type PreferenceValidation,
  type StoredPreference,
} from '@trinity/runtime/preferences';
import {
  TrustHealthService,
  type TrustHealthSnapshot,
} from './trust-health.service';
import { readPublishedMasterKey, readTrustSnapshot } from './trust-snapshot';

/** Whether the active Account's current device must be verified before the app opens. */
export type DeviceConfirmationGate =
  | { readonly kind: 'not-required' }
  | { readonly kind: 'pending' }
  | {
      readonly kind: 'required';
      readonly status: 'needs-recovery' | 'needs-verification';
    };

/** Build policy for the new-device check. */
export interface DeviceConfirmationPolicy {
  /** Debug builds only: the check offers a skip, as Element X does in debug builds. */
  readonly allowSkip: boolean;
}

export const DEVICE_CONFIRMATION_POLICY =
  new InjectionToken<DeviceConfirmationPolicy>(
    'trust.device-confirmation-policy',
    { providedIn: 'root', factory: () => ({ allowSkip: false }) },
  );

/** How long navigation waits for a new device's status before letting the route through. */
export const DEVICE_CONFIRMATION_SETTLE_MS = 10_000;

const NOT_REQUIRED: DeviceConfirmationGate = Object.freeze({
  kind: 'not-required',
});
const PENDING: DeviceConfirmationGate = Object.freeze({ kind: 'pending' });
const REQUIRED_RECOVERY: DeviceConfirmationGate = Object.freeze({
  kind: 'required',
  status: 'needs-recovery',
});
const REQUIRED_VERIFICATION: DeviceConfirmationGate = Object.freeze({
  kind: 'required',
  status: 'needs-verification',
});

/** What the homeserver said about a recorded Account's identity. */
type ServerIdentity = 'present' | 'absent' | 'unknown';

/** The gate for a recorded, current device, from one status read and the server's answer. */
function gateFor(
  snapshot: Pick<TrustHealthSnapshot, 'status' | 'thisDeviceVerified'>,
  server: ServerIdentity | undefined,
): DeviceConfirmationGate {
  if (snapshot.thisDeviceVerified) return NOT_REQUIRED;
  switch (snapshot.status) {
    case 'needs-recovery':
      return REQUIRED_RECOVERY;
    case 'needs-verification':
      return REQUIRED_VERIFICATION;
    case 'needs-setup':
      if (server === undefined) return PENDING;
      // `absent` has already dropped the record. `unknown` falls back to the local status,
      // since blocking an Account that may have no identity would trap the user: every way
      // out needs one.
      return server === 'present' ? REQUIRED_VERIFICATION : NOT_REQUIRED;
    case 'ready':
      return NOT_REQUIRED;
    default: {
      const unhandled: never = snapshot.status;
      void unhandled;
      return NOT_REQUIRED;
    }
  }
}

type DeviceConfirmationRecord = string | null;

function validateRecord(
  value: unknown,
): PreferenceValidation<DeviceConfirmationRecord> {
  return value === null ||
    (typeof value === 'string' && value.length > 0 && value.length <= 255)
    ? { kind: 'accepted', value }
    : {
        kind: 'rejected',
        diagnostic: { code: 'trust-device-confirmation-invalid' },
      };
}

function migrateRecord(
  stored: StoredPreference,
): PreferenceValidation<DeviceConfirmationRecord> {
  return stored.version === 1
    ? validateRecord(stored.value)
    : {
        kind: 'rejected',
        diagnostic: { code: 'trust-device-confirmation-migration-rejected' },
      };
}

/** The device id a sign-in created that has not been verified yet; null when none. */
export const DEVICE_CONFIRMATION_PREFERENCE =
  definePreference<DeviceConfirmationRecord>({
    id: 'trust.device-confirmation',
    owner: 'trust',
    section: 'trust',
    order: 10,
    scope: 'account',
    defaultValue: null,
    sensitivity: 'private',
    storage: 'device-preferences',
    export: 'excluded',
    editor: { kind: 'none' },
    persistence: {
      key: 'trinity.trust.device-confirmation',
      migration: { currentVersion: 1, migrate: migrateRecord },
    },
    validate: validateRecord,
  });

function accountContext(accountId: string): PreferenceContext {
  return { kind: 'account', accountId };
}

/**
 * Following MSC4153, a new device of an Account that has an identity is verified (with
 * another device or the recovery key) or the identity is reset before the app opens.
 * Existing devices are never blocked; they keep the banner.
 *
 * The record is written synchronously when Accounts reports a new-device sign-in, so the
 * sign-in page's navigation already sees it, and persisted per Account so a restart does
 * not skip the check. It is cleared when a fresh read on that exact Account says the device
 * is verified, by the debug-build skip, or as soon as the homeserver says the Account has
 * no identity; a server that cannot be asked keeps it.
 */
@Injectable({ providedIn: 'root' })
export class TrustDeviceConfirmationService {
  private readonly injector = inject(Injector);
  private readonly session = inject(SessionStateService);
  private readonly cryptoPort = inject(TrustCryptoPort);
  private readonly preferences = inject(PreferenceStoreService);
  private readonly health = inject(TrustHealthService);
  private readonly policy = inject(DEVICE_CONFIRMATION_POLICY);
  /** Account id → the device id a sign-in created that is not verified yet. */
  private readonly records = signal<ReadonlyMap<string, string>>(new Map());
  /** Accounts whose persisted record has been read, or superseded by a sign-in. */
  private readonly hydrated = signal<ReadonlySet<string>>(new Set());
  /**
   * What the homeserver said about each recorded Account's identity, asked once per new
   * device: right after sign-in the device may not have downloaded its own identity yet,
   * and the local read then says `needs-setup` for an Account that has one.
   */
  private readonly serverIdentity = signal<ReadonlyMap<string, ServerIdentity>>(
    new Map(),
  );
  private readonly hydrations = new Map<string, Observable<void>>();
  private readonly serverChecks = new Map<string, Observable<void>>();
  private gate$: Observable<DeviceConfirmationGate> | null = null;
  private activeAccount$: Observable<string | null> | null = null;

  /** The active Account, for the check screen. */
  readonly activeAccountId = this.session.activeAccountId;
  /** Whether this build offers "Skip for now". */
  readonly canSkip = this.policy.allowSkip;

  readonly gate = computed<DeviceConfirmationGate>(() => {
    const accountId = this.session.activeAccountId();
    if (!accountId) return NOT_REQUIRED;
    if (!this.hydrated().has(accountId)) return PENDING;
    const deviceId = this.records().get(accountId);
    if (!deviceId || deviceId !== untracked(() => this.deviceIdOf(accountId))) {
      return NOT_REQUIRED;
    }
    const health = this.health.health();
    if (health.availability !== 'coherent') return PENDING;
    return gateFor(health.current, this.serverIdentity().get(accountId));
  });

  /** Record that `deviceId` is a new device of `accountId`, then ask the server about it. */
  require(accountId: string, deviceId: string): Observable<void> {
    return defer(() => {
      this.records.update((records) =>
        new Map(records).set(accountId, deviceId),
      );
      this.forgetServerAnswer(accountId);
      this.markHydrated(accountId);
      return this.persist(accountId, deviceId).pipe(
        switchMap(() => this.checkServerIdentity(accountId)),
      );
    });
  }

  /** Load an Account's persisted record once (later calls share it), then check the server. */
  hydrate(accountId: string): Observable<void> {
    return defer(() => {
      if (this.hydrated().has(accountId)) {
        return this.checkServerIdentity(accountId);
      }
      let read = this.hydrations.get(accountId);
      if (!read) {
        const context = accountContext(accountId);
        read = this.preferences
          .hydrateDescriptors(context, [DEVICE_CONFIRMATION_PREFERENCE])
          .pipe(
            map(
              () =>
                this.preferences.stateFor(
                  DEVICE_CONFIRMATION_PREFERENCE,
                  context,
                )().value,
            ),
            // An unreadable record proves nothing; treat it as no record (fails open).
            catchError(() => of(null)),
            map((stored) => {
              // A sign-in recorded a newer device while the read was in flight.
              if (this.hydrated().has(accountId)) return;
              if (stored) {
                this.records.update((records) =>
                  new Map(records).set(accountId, stored),
                );
              }
              this.markHydrated(accountId);
            }),
            shareReplay({ bufferSize: 1, refCount: false }),
          );
        this.hydrations.set(accountId, read);
      }
      return read.pipe(switchMap(() => this.checkServerIdentity(accountId)));
    });
  }

  /** Clear the record when a fresh read on that exact Account says its device is verified. */
  completeIfVerified(accountId: string): Observable<void> {
    return defer(() => {
      if (!this.records().has(accountId)) return of(undefined);
      const context = this.cryptoPort.forAccount(accountId);
      if (!context?.crypto) return of(undefined);
      return from(readTrustSnapshot(context.client, context.crypto)).pipe(
        switchMap((snapshot) =>
          snapshot.thisDeviceVerified ? this.clear(accountId) : of(undefined),
        ),
        catchError(() => of(undefined)),
      );
    });
  }

  /**
   * Whether the active Account's current device still needs the check, from a fresh read of
   * that exact Account. Just after an Account switch, {@link gate} can pair the new Account
   * with the previous one's status for a moment, because Trust health re-projects in an
   * effect; the guard and the coordinator confirm with this before they act on `required`.
   * Any failure answers `false`: the check never traps someone it cannot confirm.
   */
  confirmRequired(): Observable<boolean> {
    return defer(() => {
      const accountId = this.session.activeAccountId();
      const deviceId = accountId ? this.records().get(accountId) : undefined;
      const context = accountId ? this.cryptoPort.forAccount(accountId) : null;
      if (
        !accountId ||
        !deviceId ||
        !context?.crypto ||
        this.deviceIdOf(accountId) !== deviceId
      ) {
        return of(false);
      }
      return from(readTrustSnapshot(context.client, context.crypto)).pipe(
        map(
          (snapshot) =>
            gateFor(snapshot, this.serverIdentity().get(accountId)).kind ===
            'required',
        ),
        catchError(() => of(false)),
      );
    });
  }

  /** Debug builds only: let this device in unverified; it then gets the banner. */
  skip(): Observable<void> {
    return defer(() => {
      const accountId = this.session.activeAccountId();
      if (!this.policy.allowSkip || !accountId) {
        return throwError(
          () =>
            new Error(
              'Skipping the new-device check is only available in debug builds.',
            ),
        );
      }
      return this.clear(accountId);
    });
  }

  /**
   * The active Account's gate once it no longer depends on loading state, for route guards.
   * Answers at once when the gate is already settled. Otherwise it waits for an active
   * Account, its record and its status; after {@link DEVICE_CONFIRMATION_SETTLE_MS} it lets
   * the route through, and the session coordinator redirects if the check turns out to be
   * required later.
   */
  settledGate(): Observable<DeviceConfirmationGate> {
    return defer(() => {
      this.gate$ ??= toObservable(this.gate, { injector: this.injector });
      const gate$ = this.gate$;
      return this.activeAccount().pipe(
        switchMap((accountId) =>
          merge(
            this.hydrate(accountId).pipe(ignoreElements()),
            // Read now: a computed is fresh on read, while `gate$` re-emits only after its
            // effect runs. `gate$` only signals a change (it replays its last value, which
            // can predate the record or the Account), so every emission re-reads the computed.
            concat(of(undefined), gate$).pipe(map(() => this.gate())),
          ),
        ),
        filter((gate) => gate.kind !== 'pending'),
        take(1),
        timeout({
          first: DEVICE_CONFIRMATION_SETTLE_MS,
          with: () => of(NOT_REQUIRED),
        }),
      );
    });
  }

  /** The active Account id now, or as soon as there is one. */
  private activeAccount(): Observable<string> {
    const current = this.session.activeAccountId();
    if (current) return of(current);
    this.activeAccount$ ??= toObservable(this.session.activeAccountId, {
      injector: this.injector,
    });
    return this.activeAccount$.pipe(
      map(() => this.session.activeAccountId()),
      filter((id): id is string => id !== null),
      take(1),
    );
  }

  /** Ask the homeserver once whether a recorded new device's Account has an identity. */
  private checkServerIdentity(accountId: string): Observable<void> {
    return defer(() => {
      const deviceId = this.records().get(accountId);
      if (!deviceId || this.serverIdentity().has(accountId)) {
        return of(undefined);
      }
      let check = this.serverChecks.get(accountId);
      if (!check) {
        const context = this.cryptoPort.forAccount(accountId);
        // Accounts publishes a new device as soon as its record is saved, before its
        // session starts: ask once it is live (the next hydrate). A record left by an
        // earlier device of this Account is ignored by the gate.
        if (!context || this.deviceIdOf(accountId) !== deviceId) {
          return of(undefined);
        }
        const answer: Observable<ServerIdentity> = from(
          readPublishedMasterKey(context.client),
        ).pipe(
          map((key): ServerIdentity => (key ? 'present' : 'absent')),
          catchError(() => of<ServerIdentity>('unknown')),
        );
        // An answer that lands after `require()` recorded a newer sign-in is stale.
        const isCurrent = () => this.serverChecks.get(accountId) === check;
        check = answer.pipe(
          switchMap((identity) =>
            isCurrent()
              ? this.keepOnlyWithIdentity(accountId, identity).pipe(
                  map(() => identity),
                )
              : of(null),
          ),
          map((identity) => {
            if (identity === null || !isCurrent()) return;
            this.serverIdentity.update((known) =>
              new Map(known).set(accountId, identity),
            );
          }),
          shareReplay({ bufferSize: 1, refCount: false }),
        );
        this.serverChecks.set(accountId, check);
      }
      return check;
    });
  }

  /**
   * A device that signs in while its Account has no identity is an existing device from then
   * on, never sent to the check, even if an identity is set up elsewhere later; it keeps the
   * banner. Only the homeserver's answer proves that. A server that cannot be asked proves
   * nothing, so the record stays and the gate follows this device's own status (failing
   * open while it reads `needs-setup`).
   */
  private keepOnlyWithIdentity(
    accountId: string,
    identity: ServerIdentity,
  ): Observable<void> {
    switch (identity) {
      case 'present':
      case 'unknown':
        return of(undefined);
      case 'absent':
        return this.clear(accountId);
      default: {
        const unhandled: never = identity;
        void unhandled;
        return of(undefined);
      }
    }
  }

  private forgetServerAnswer(accountId: string): void {
    this.serverChecks.delete(accountId);
    if (!this.serverIdentity().has(accountId)) return;
    this.serverIdentity.update((known) => {
      const next = new Map(known);
      next.delete(accountId);
      return next;
    });
  }

  private clear(accountId: string): Observable<void> {
    return defer(() => {
      if (!this.records().has(accountId)) return of(undefined);
      this.records.update((records) => {
        const next = new Map(records);
        next.delete(accountId);
        return next;
      });
      return this.persist(accountId, null);
    });
  }

  /**
   * Best effort: the in-memory record governs this session; a failed write only means a
   * restart before verifying would not ask again.
   */
  private persist(
    accountId: string,
    value: DeviceConfirmationRecord,
  ): Observable<void> {
    return this.preferences
      .setPreference(
        DEVICE_CONFIRMATION_PREFERENCE,
        accountContext(accountId),
        value,
      )
      .pipe(
        map(() => undefined),
        catchError(() => of(undefined)),
      );
  }

  private markHydrated(accountId: string): void {
    if (this.hydrated().has(accountId)) return;
    this.hydrated.update((ids) => new Set(ids).add(accountId));
  }

  private deviceIdOf(accountId: string): string | null {
    return this.session.status(accountId)?.deviceId ?? null;
  }
}
