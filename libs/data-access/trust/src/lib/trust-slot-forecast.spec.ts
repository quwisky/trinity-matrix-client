import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrustCryptoPort } from '@trinity/data-access/matrix-client';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceStorageAdapter,
  type PreferenceStorageRequest,
} from '@trinity/runtime/preferences';
import {
  TrustHealthService,
  type TrustHealth,
  type TrustHealthSnapshot,
} from './trust-health.service';
import {
  FORECAST_HOLD_MS,
  TrustSlotForecastService,
} from './trust-slot-forecast';

type LiveStatus = TrustHealthSnapshot['status'];

const UNAVAILABLE: TrustHealth = {
  availability: 'unavailable',
  current: null,
  stale: null,
};

function snapshot(
  status: LiveStatus,
  overrides: Partial<TrustHealthSnapshot> = {},
): TrustHealthSnapshot {
  return {
    status,
    keyBackupActive: false,
    thisDeviceVerified: false,
    identityElsewhere: false,
    ...overrides,
  };
}

function coherent(
  status: LiveStatus,
  overrides: Partial<TrustHealthSnapshot> = {},
): TrustHealth {
  return {
    availability: 'coherent',
    current: snapshot(status, overrides),
    stale: null,
  };
}

const FORECAST_KEY = 'trinity.trust.slot-forecast';

/** Persisted payloads, by storage key and Account, shared across "restarts". */
type Store = Map<string, string>;

function storageKey(request: PreferenceStorageRequest): string {
  const account =
    request.context.kind === 'account' ? request.context.accountId : '';
  return `${request.key}|${account}`;
}

/** A stored forecast record, as the preference store writes one. */
function record(value: unknown, version = 1): string {
  return JSON.stringify({ version, value });
}

function setup(store: Store = new Map()) {
  const adapter: PreferenceStorageAdapter = {
    read: (request) => {
      const payload = store.get(storageKey(request));
      return of(
        payload === undefined
          ? ({ kind: 'missing' } as const)
          : ({ kind: 'found', payload } as const),
      );
    },
    write: (request) => {
      store.set(storageKey(request), request.payload);
      return of({ kind: 'completed' } as const);
    },
  };
  const active = signal<string | null>(null);
  const health = signal<TrustHealth>(UNAVAILABLE);
  const recoverySetupElsewhere = computed(() => {
    const current = health().current;
    return (
      current?.status === 'needs-setup' &&
      current.thisDeviceVerified &&
      current.identityElsewhere
    );
  });
  TestBed.configureTestingModule({
    providers: [
      TrustSlotForecastService,
      MockProvider(TrustCryptoPort, { activeAccountId: active.asReadonly() }),
      MockProvider(TrustHealthService, {
        health: health.asReadonly(),
        recoverySetupElsewhere,
      }),
      { provide: PREFERENCE_STORAGE_ADAPTER, useValue: adapter },
    ],
  });
  return {
    forecast: TestBed.inject(TrustSlotForecastService),
    store,
    active,
    health,
    recoverySetupElsewhere,
  };
}

type Harness = ReturnType<typeof setup>;

/** A fresh app start: a new service over the storage the previous one wrote to. */
function restart(previous: Harness): Harness {
  TestBed.resetTestingModule();
  return setup(previous.store);
}

/** Run a live status through the service, as Trust health would publish it. */
function publish(harness: Harness, health: TrustHealth): void {
  harness.health.set(health);
  TestBed.tick();
}

afterEach(() => {
  vi.useRealTimers();
  TestBed.resetTestingModule();
});

describe('TrustSlotForecastService', () => {
  it('forecasts nothing for an Account it has never seen', async () => {
    const { forecast, active } = setup();
    active.set('@a:hs');
    await firstValueFrom(forecast.hydrate('@a:hs'));

    expect(forecast.forecast()).toBeNull();
  });

  it('remembers the live prompt and forecasts it after a restart', async () => {
    const first = setup();
    first.active.set('@a:hs');
    await firstValueFrom(first.forecast.hydrate('@a:hs'));
    publish(first, coherent('needs-recovery'));
    // The live status is known: it governs, and there is nothing to forecast.
    expect(first.forecast.forecast()).toBeNull();

    const restarted = restart(first);
    restarted.active.set('@a:hs');
    await firstValueFrom(restarted.forecast.hydrate('@a:hs'));

    expect(restarted.forecast.forecast()).toBe('needs-recovery');
  });

  it('forgets the prompt once the Account is ready', async () => {
    const first = setup();
    first.active.set('@a:hs');
    await firstValueFrom(first.forecast.hydrate('@a:hs'));
    publish(first, coherent('needs-setup'));
    publish(first, coherent('ready'));

    const restarted = restart(first);
    restarted.active.set('@a:hs');
    await firstValueFrom(restarted.forecast.hydrate('@a:hs'));

    expect(restarted.forecast.forecast()).toBeNull();
  });

  it('records setup-elsewhere for a verified device without the identity', async () => {
    const first = setup();
    first.active.set('@a:hs');
    await firstValueFrom(first.forecast.hydrate('@a:hs'));
    publish(
      first,
      coherent('needs-setup', {
        thisDeviceVerified: true,
        identityElsewhere: true,
      }),
    );
    expect(first.recoverySetupElsewhere()).toBe(true);

    const restarted = restart(first);
    restarted.active.set('@a:hs');
    await firstValueFrom(restarted.forecast.hydrate('@a:hs'));

    expect(restarted.forecast.forecast()).toBe('setup-elsewhere');
  });

  it('stores only the prompt kind, under its own key for the Account', async () => {
    const harness = setup();
    harness.active.set('@a:hs');
    await firstValueFrom(harness.forecast.hydrate('@a:hs'));
    publish(harness, coherent('needs-verification'));

    expect([...harness.store]).toEqual([
      [`${FORECAST_KEY}|@a:hs`, record('needs-verification')],
    ]);
  });

  it('uses a stale snapshot as the forecast', () => {
    const { forecast, active, health } = setup();
    active.set('@a:hs');
    health.set({
      availability: 'stale',
      current: null,
      stale: snapshot('needs-verification'),
    });

    expect(forecast.forecast()).toBe('needs-verification');
  });

  it('drops the forecast when the live status stays unavailable past the hold', async () => {
    vi.useFakeTimers();
    const harness = setup(
      new Map([[`${FORECAST_KEY}|@a:hs`, record('needs-setup')]]),
    );
    harness.active.set('@a:hs');
    await firstValueFrom(harness.forecast.hydrate('@a:hs'));
    publish(harness, UNAVAILABLE);
    expect(harness.forecast.forecast()).toBe('needs-setup');

    vi.advanceTimersByTime(FORECAST_HOLD_MS - 1);
    expect(harness.forecast.forecast()).toBe('needs-setup');

    vi.advanceTimersByTime(1);
    expect(harness.forecast.forecast()).toBeNull();
  });

  it('forecasts again after a live status follows an expired hold', async () => {
    vi.useFakeTimers();
    const harness = setup(
      new Map([[`${FORECAST_KEY}|@a:hs`, record('needs-recovery')]]),
    );
    harness.active.set('@a:hs');
    await firstValueFrom(harness.forecast.hydrate('@a:hs'));
    publish(harness, UNAVAILABLE);
    vi.advanceTimersByTime(FORECAST_HOLD_MS);
    expect(harness.forecast.forecast()).toBeNull();

    publish(harness, coherent('needs-recovery'));
    publish(harness, UNAVAILABLE);

    expect(harness.forecast.forecast()).toBe('needs-recovery');
  });

  it('drops the forecast when the active Account changes', async () => {
    const harness = setup(
      new Map([[`${FORECAST_KEY}|@a:hs`, record('needs-setup')]]),
    );
    harness.active.set('@a:hs');
    await firstValueFrom(harness.forecast.hydrate('@a:hs'));
    expect(harness.forecast.forecast()).toBe('needs-setup');

    harness.active.set('@b:hs');
    await firstValueFrom(harness.forecast.hydrate('@b:hs'));

    expect(harness.forecast.forecast()).toBeNull();
  });

  it.each([
    ['text that is not a record', '{not json'],
    ['an unknown prompt kind', record('needs-everything')],
    ['a record from an unknown version', record('needs-setup', 9)],
  ])('fails open on an unreadable record: %s', async (_case, payload) => {
    const harness = setup(new Map([[`${FORECAST_KEY}|@a:hs`, payload]]));
    harness.active.set('@a:hs');

    await expect(
      firstValueFrom(harness.forecast.hydrate('@a:hs'), {
        defaultValue: 'no value',
      }),
    ).resolves.toBeUndefined();
    expect(harness.forecast.forecast()).toBeNull();
  });
});
