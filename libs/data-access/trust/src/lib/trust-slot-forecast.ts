import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  Observable,
  catchError,
  defer,
  filter,
  map,
  of,
  shareReplay,
  switchMap,
  take,
} from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
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

/** Which encryption prompt an Account's device last needed. Layout only — never a decision. */
export type SlotForecast =
  'needs-setup' | 'needs-recovery' | 'needs-verification' | 'setup-elsewhere';

type StoredForecast = SlotForecast | 'none';

/**
 * Backstop: how long a forecast may hold the slot while the live status stays unavailable.
 * A reported Trust failure ends it sooner (the slot owner drops the forecast at once), so
 * this only bounds a start that neither finishes nor fails.
 */
export const FORECAST_HOLD_MS = 10_000;

const KINDS: readonly StoredForecast[] = [
  'none',
  'needs-setup',
  'needs-recovery',
  'needs-verification',
  'setup-elsewhere',
];

function isStoredForecast(value: unknown): value is StoredForecast {
  return KINDS.some((kind) => kind === value);
}

function validateForecast(
  value: unknown,
): PreferenceValidation<StoredForecast | null> {
  return value === null || isStoredForecast(value)
    ? { kind: 'accepted', value }
    : {
        kind: 'rejected',
        diagnostic: { code: 'trust-slot-forecast-rejected' },
      };
}

function migrateForecast(
  stored: StoredPreference,
): PreferenceValidation<StoredForecast | null> {
  return stored.version === 1
    ? validateForecast(stored.value)
    : {
        kind: 'rejected',
        diagnostic: { code: 'trust-slot-forecast-migration-rejected' },
      };
}

/** The prompt kind this device last needed for an Account; null when never recorded. */
export const SLOT_FORECAST_PREFERENCE = definePreference<StoredForecast | null>(
  {
    id: 'trust.slot-forecast',
    owner: 'trust',
    section: 'trust',
    order: 20,
    scope: 'account',
    defaultValue: null,
    sensitivity: 'private',
    storage: 'device-preferences',
    export: 'excluded',
    editor: { kind: 'none' },
    persistence: {
      key: 'trinity.trust.slot-forecast',
      migration: { currentVersion: 1, migrate: migrateForecast },
    },
    validate: validateForecast,
  },
);

function forecastOf(
  snapshot: Pick<
    TrustHealthSnapshot,
    'status' | 'thisDeviceVerified' | 'identityElsewhere'
  >,
): StoredForecast {
  // The same case as `TrustHealthService.recoverySetupElsewhere`, read from the snapshot.
  if (
    snapshot.status === 'needs-setup' &&
    snapshot.thisDeviceVerified &&
    snapshot.identityElsewhere
  ) {
    return 'setup-elsewhere';
  }
  return snapshot.status === 'ready' ? 'none' : snapshot.status;
}

function accountContext(accountId: string): PreferenceContext {
  return { kind: 'account', accountId };
}

/**
 * Remembers, per Account on this device, which encryption prompt its device last needed, so
 * the global banner slot can reserve exactly that banner's space before the live status
 * arrives on the next start. It never stands in for the status: Trust decisions and flows
 * read {@link TrustHealthService} only. Reads and writes are best effort and fail open.
 */
@Injectable({ providedIn: 'root' })
export class TrustSlotForecastService {
  private readonly health = inject(TrustHealthService);
  private readonly session = inject(SessionStateService);
  private readonly preferences = inject(PreferenceStoreService);
  /** Account id → the prompt kind last read from storage or seen live. */
  private readonly stored = signal<ReadonlyMap<string, StoredForecast>>(
    new Map(),
  );
  /** Accounts whose forecast has outlived FORECAST_HOLD_MS without a live status. */
  private readonly expired = signal<ReadonlySet<string>>(new Set());
  private readonly reads = new Map<string, Observable<void>>();
  private readonly activeAccountId$ = toObservable(
    this.session.activeAccountId,
  );
  private readonly unavailable = computed(
    () => this.health.health().availability === 'unavailable',
  );

  /**
   * The active Account's stored encryption prompt while its live status is still
   * unavailable, as at start-up; null otherwise, including for a stale snapshot.
   */
  readonly forecast = computed<SlotForecast | null>(() => {
    const accountId = this.session.activeAccountId();
    if (!accountId) return null;
    // A stale snapshot means a read failed mid-session; the failure notice owns the slot then.
    if (this.health.health().availability !== 'unavailable') return null;
    if (this.expired().has(accountId)) return null;
    const kind = this.stored().get(accountId) ?? 'none';
    return kind === 'none' ? null : kind;
  });

  constructor() {
    // Remember what the live status says, for the Account it belongs to. Just after an
    // Account switch, Trust health can still hold the previous Account's status, so the
    // run that sees a new Account records nothing; the next status change records it.
    let seenAccountId: string | null | undefined;
    effect(() => {
      const accountId = this.session.activeAccountId();
      const current = this.health.health().current;
      const switched =
        seenAccountId !== undefined && accountId !== seenAccountId;
      seenAccountId = accountId;
      if (switched || !accountId || !current) return;
      untracked(() => this.remember(accountId, forecastOf(current)));
    });
    // A forecast must not reserve space for a status that never arrives. Each hold starts
    // afresh, so an Account that becomes active again forecasts again.
    effect((onCleanup) => {
      const accountId = this.session.activeAccountId();
      if (!accountId || !this.unavailable()) return;
      untracked(() => this.clearExpired(accountId));
      const timer = setTimeout(
        () => this.expired.update((ids) => new Set(ids).add(accountId)),
        FORECAST_HOLD_MS,
      );
      onCleanup(() => clearTimeout(timer));
    });
    // An Account switch does not pass through the route guard: read its forecast here.
    effect(() => {
      const accountId = this.session.activeAccountId();
      if (accountId) untracked(() => this.hydrate(accountId).subscribe());
    });
  }

  /**
   * Load the active Account's stored forecast. With no active Account yet, it waits for
   * one; the caller bounds how long it waits.
   */
  hydrateActive(): Observable<void> {
    return defer(() => {
      const accountId = this.session.activeAccountId();
      return accountId
        ? this.hydrate(accountId)
        : this.activeAccountId$.pipe(
            filter((id): id is string => id !== null),
            take(1),
            switchMap((id) => this.hydrate(id)),
          );
    });
  }

  /**
   * Load an Account's stored forecast once (later calls share the read). It never errors;
   * the caller bounds how long it waits.
   */
  hydrate(accountId: string): Observable<void> {
    return defer(() => {
      let read = this.reads.get(accountId);
      if (!read) {
        const context = accountContext(accountId);
        read = this.preferences
          .hydrateDescriptors(context, [SLOT_FORECAST_PREFERENCE])
          .pipe(
            map(
              () =>
                this.preferences.stateFor(SLOT_FORECAST_PREFERENCE, context)()
                  .value,
            ),
            // An unreadable record forecasts nothing (fails open).
            catchError(() => of(null)),
            map((value) => {
              // A live status seen while the read was in flight wins.
              if (value && !this.stored().has(accountId)) {
                this.stored.update((known) =>
                  new Map(known).set(accountId, value),
                );
              }
            }),
            shareReplay({ bufferSize: 1, refCount: false }),
          );
        this.reads.set(accountId, read);
      }
      return read;
    });
  }

  private remember(accountId: string, kind: StoredForecast): void {
    // A live status ends any expired hold, so the next gap forecasts again.
    this.clearExpired(accountId);
    if (this.stored().get(accountId) === kind) return;
    this.stored.update((known) => new Map(known).set(accountId, kind));
    // Best effort: a failed write only means the next start forecasts an older prompt.
    this.preferences
      .setPreference(SLOT_FORECAST_PREFERENCE, accountContext(accountId), kind)
      .pipe(catchError(() => of(undefined)))
      .subscribe();
  }

  private clearExpired(accountId: string): void {
    if (!this.expired().has(accountId)) return;
    this.expired.update((ids) => {
      const next = new Set(ids);
      next.delete(accountId);
      return next;
    });
  }
}
