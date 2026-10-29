import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SessionStateService,
  TrustCryptoPort,
  type SessionAccountStatus,
} from '@trinity/data-access/matrix-client';
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
  DEVICE_CONFIRMATION_POLICY,
  DEVICE_CONFIRMATION_PREFERENCE,
  DEVICE_CONFIRMATION_SETTLE_MS,
  TrustDeviceConfirmationService,
  type DeviceConfirmationGate,
} from './trust-device-confirmation.service';

const UNAVAILABLE: TrustHealth = {
  availability: 'unavailable',
  current: null,
  stale: null,
};

function coherent(snapshot: Partial<TrustHealthSnapshot>): TrustHealth {
  return {
    availability: 'coherent',
    current: {
      status: 'needs-recovery',
      keyBackupActive: false,
      thisDeviceVerified: false,
      identityElsewhere: false,
      ...snapshot,
    },
    stale: null,
  };
}

/** The homeserver's `/keys/query` answer when the Account has a published identity. */
const PUBLISHED = {
  master_keys: {
    '@a:hs': {
      user_id: '@a:hs',
      usage: ['master'],
      keys: { 'ed25519:MASTER': 'MASTER' },
    },
  },
};

/** Persisted payloads, by storage key and Account, shared across "restarts". */
type Store = Map<string, string>;

function storageKey(request: PreferenceStorageRequest): string {
  const account =
    request.context.kind === 'account' ? request.context.accountId : '';
  return `${request.key}|${account}`;
}

interface Options {
  store?: Store;
  allowSkip?: boolean;
  active?: string | null;
  deviceId?: string;
  verifiedNow?: boolean;
  /** The homeserver's `/keys/query` answer; by default the account has an identity. */
  server?: () => Promise<unknown>;
  /** What this device's own fresh read says while it is unverified. */
  local?: 'needs-recovery' | 'needs-verification' | 'needs-setup';
  readFails?: boolean;
  /** This device's own status read throws. */
  localReadFails?: boolean;
  writeFails?: boolean;
  /** Whether the Account's session is live yet; by default it is. */
  live?: boolean;
}

function setup(options: Options = {}) {
  const store: Store = options.store ?? new Map();
  const adapter: PreferenceStorageAdapter = {
    read: (request) => {
      if (options.readFails) {
        return of({
          kind: 'unavailable',
          diagnostic: { code: 'test-locked' },
        } as const);
      }
      const payload = store.get(storageKey(request));
      return of(
        payload === undefined
          ? ({ kind: 'missing' } as const)
          : ({ kind: 'found', payload } as const),
      );
    },
    write: (request) => {
      if (options.writeFails) {
        return of({
          kind: 'unavailable',
          diagnostic: { code: 'test-full' },
        } as const);
      }
      store.set(storageKey(request), request.payload);
      return of({ kind: 'completed' } as const);
    },
  };
  const activeAccountId = signal<string | null>(
    options.active === undefined ? '@a:hs' : options.active,
  );
  const health = signal<TrustHealth>(UNAVAILABLE);
  const verifiedNow = { value: options.verifiedNow ?? false };
  const live = { value: options.live ?? true };
  const local = options.local ?? 'needs-recovery';
  const defaultKeyId = local === 'needs-recovery' ? 'k' : null;
  const downloadKeysForUsers = vi.fn(options.server ?? (async () => PUBLISHED));
  const crypto = {
    isCrossSigningReady: vi.fn(async () => verifiedNow.value),
    isSecretStorageReady: vi.fn(async () => {
      if (options.localReadFails) throw new Error('read failed');
      return defaultKeyId !== null;
    }),
    getActiveSessionBackupVersion: vi.fn(async () => null),
    getDeviceVerificationStatus: vi.fn(async () => ({
      crossSigningVerified: verifiedNow.value,
    })),
    getCrossSigningStatus: vi.fn(async () => {
      return {
        publicKeysOnDevice: local !== 'needs-setup',
        privateKeysInSecretStorage: defaultKeyId !== null,
        privateKeysCachedLocally: {
          masterKey: false,
          selfSigningKey: false,
          userSigningKey: false,
        },
      };
    }),
  };
  const client = {
    getDeviceId: () => options.deviceId ?? 'DEVICE',
    getUserId: () => '@a:hs',
    secretStorage: { getDefaultKeyId: vi.fn(async () => defaultKeyId) },
    downloadKeysForUsers,
  };
  TestBed.configureTestingModule({
    providers: [
      TrustDeviceConfirmationService,
      MockProvider(SessionStateService, {
        activeAccountId: activeAccountId.asReadonly(),
        status: (id: string) =>
          id === '@a:hs' && live.value
            ? ({
                deviceId: options.deviceId ?? 'DEVICE',
              } as SessionAccountStatus)
            : null,
      }),
      MockProvider(TrustCryptoPort, {
        forAccount: (id: string) =>
          id === '@a:hs' && live.value ? ({ client, crypto } as never) : null,
      }),
      MockProvider(TrustHealthService, { health: health.asReadonly() }),
      { provide: PREFERENCE_STORAGE_ADAPTER, useValue: adapter },
      {
        provide: DEVICE_CONFIRMATION_POLICY,
        useValue: { allowSkip: options.allowSkip ?? false },
      },
    ],
  });
  return {
    service: TestBed.inject(TrustDeviceConfirmationService),
    store,
    activeAccountId,
    health,
    verifiedNow,
    live,
    downloadKeysForUsers,
  };
}

afterEach(() => {
  vi.useRealTimers();
  TestBed.resetTestingModule();
});

describe('TrustDeviceConfirmationService', () => {
  it('requires a new device to be verified while its account needs recovery', async () => {
    const { service, health } = setup();
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));
    health.set(coherent({ status: 'needs-recovery' }));

    expect(service.gate()).toEqual({
      kind: 'required',
      status: 'needs-recovery',
    });
  });

  it('requires it too when the identity has no recovery', async () => {
    const { service, health } = setup();
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));
    health.set(
      coherent({ status: 'needs-verification', identityElsewhere: true }),
    );

    expect(service.gate()).toEqual({
      kind: 'required',
      status: 'needs-verification',
    });
  });

  it('never requires a device the account already used', async () => {
    const { service, health } = setup();
    await firstValueFrom(service.hydrate('@a:hs'));
    health.set(coherent({ status: 'needs-recovery' }));

    expect(service.gate()).toEqual({ kind: 'not-required' });
  });

  it('is pending until trust status for the device is known', async () => {
    const { service } = setup();
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));

    expect(service.gate()).toEqual({ kind: 'pending' });
  });

  it('waits for the server on an account that looks unset, then lets one without an identity through', async () => {
    let answer!: (value: unknown) => void;
    const { service, health } = setup({
      server: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    const recorded = firstValueFrom(service.require('@a:hs', 'DEVICE'), {
      defaultValue: undefined,
    });
    health.set(coherent({ status: 'needs-setup' }));

    expect(service.gate()).toEqual({ kind: 'pending' });

    answer({ master_keys: {} });
    await recorded;
    expect(service.gate()).toEqual({ kind: 'not-required' });
  });

  it('never sends a device that signed in without an identity, even after one appears elsewhere', async () => {
    // Owner decision 2026-10-12 (1): no identity at sign-in means no record.
    const first = setup({
      server: async () => ({ master_keys: {} }),
      local: 'needs-setup',
    });
    await firstValueFrom(first.service.require('@a:hs', 'DEVICE'));
    expect([...first.store.values()].join()).not.toContain('DEVICE');

    // Another device sets up an identity; this one now reads needs-verification.
    first.health.set(
      coherent({ status: 'needs-verification', identityElsewhere: true }),
    );
    expect(first.service.gate()).toEqual({ kind: 'not-required' });

    // Nor after a restart.
    TestBed.resetTestingModule();
    const restarted = setup({
      store: first.store,
      local: 'needs-verification',
    });
    await firstValueFrom(restarted.service.hydrate('@a:hs'));
    restarted.health.set(
      coherent({ status: 'needs-verification', identityElsewhere: true }),
    );
    expect(restarted.service.gate()).toEqual({ kind: 'not-required' });
  });

  it('asks the server when the local read lags behind the published identity', async () => {
    const { service, health } = setup({ server: async () => PUBLISHED });
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));
    health.set(coherent({ status: 'needs-setup' }));

    expect(service.gate()).toEqual({
      kind: 'required',
      status: 'needs-verification',
    });
  });

  it('falls back to this device’s own read when the server cannot be asked, and keeps the record', async () => {
    const { service, health, store } = setup({
      server: async () => {
        throw new Error('offline');
      },
      local: 'needs-setup',
    });
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));
    health.set(coherent({ status: 'needs-setup' }));

    // Unreachable proves nothing about the identity: fail open now, keep the record.
    expect(service.gate()).toEqual({ kind: 'not-required' });
    expect([...store.values()].join()).toContain('DEVICE');

    // The device's own identity download then shows the identity: the check applies.
    health.set(coherent({ status: 'needs-verification' }));
    expect(service.gate()).toEqual({
      kind: 'required',
      status: 'needs-verification',
    });
  });

  it('keeps the check when the server cannot be asked but this device sees an identity', async () => {
    const { service, health } = setup({
      server: async () => {
        throw new Error('offline');
      },
      local: 'needs-recovery',
    });
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));
    health.set(coherent({ status: 'needs-recovery' }));

    expect(service.gate()).toEqual({
      kind: 'required',
      status: 'needs-recovery',
    });
  });

  it('asks the server once the session is live, when the device was recorded before it started', async () => {
    // Accounts publishes a new device as soon as its record is saved, before its session
    // starts: nothing can be asked yet, and that proves nothing about the identity.
    const { service, health, live, downloadKeysForUsers } = setup({
      live: false,
      local: 'needs-setup',
    });
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));
    expect(downloadKeysForUsers).not.toHaveBeenCalled();

    live.value = true;
    await firstValueFrom(service.hydrate('@a:hs'));
    health.set(coherent({ status: 'needs-setup' }));

    expect(downloadKeysForUsers).toHaveBeenCalledOnce();
    expect(service.gate()).toEqual({
      kind: 'required',
      status: 'needs-verification',
    });
  });

  it('asks the server once per new device', async () => {
    const { service, downloadKeysForUsers } = setup({
      server: async () => PUBLISHED,
    });
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));
    await firstValueFrom(service.hydrate('@a:hs'));
    service.settledGate().subscribe().unsubscribe();

    expect(downloadKeysForUsers).toHaveBeenCalledOnce();
  });

  it('stops requiring once this device is verified', async () => {
    const { service, health } = setup();
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));
    health.set(
      coherent({ status: 'needs-recovery', thisDeviceVerified: true }),
    );

    expect(service.gate()).toEqual({ kind: 'not-required' });
  });

  it('keeps requiring a new device after a restart', async () => {
    const first = setup();
    await firstValueFrom(first.service.require('@a:hs', 'DEVICE'));
    TestBed.resetTestingModule();

    const restarted = setup({ store: first.store });
    expect(restarted.service.gate()).toEqual({ kind: 'pending' });
    await firstValueFrom(restarted.service.hydrate('@a:hs'));
    restarted.health.set(coherent({ status: 'needs-recovery' }));

    expect(restarted.service.gate()).toEqual({
      kind: 'required',
      status: 'needs-recovery',
    });
  });

  it('ignores a record left by an earlier device of the same account', async () => {
    const first = setup({ deviceId: 'OLD' });
    await firstValueFrom(first.service.require('@a:hs', 'OLD'));
    TestBed.resetTestingModule();

    const next = setup({ store: first.store, deviceId: 'NEW' });
    await firstValueFrom(next.service.hydrate('@a:hs'));
    next.health.set(coherent({ status: 'needs-recovery' }));

    expect(next.service.gate()).toEqual({ kind: 'not-required' });
  });

  it('applies only to the active account', async () => {
    const { service, health, activeAccountId } = setup({ active: '@b:hs' });
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));
    await firstValueFrom(service.hydrate('@b:hs'));
    health.set(coherent({ status: 'needs-recovery' }));

    expect(service.gate()).toEqual({ kind: 'not-required' });

    activeAccountId.set('@a:hs');
    expect(service.gate()).toEqual({
      kind: 'required',
      status: 'needs-recovery',
    });
  });

  it('clears the record only when a fresh read says the device is verified', async () => {
    const { service, health, verifiedNow, store } = setup();
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));
    health.set(coherent({ status: 'needs-recovery' }));

    await firstValueFrom(service.completeIfVerified('@a:hs'));
    expect(service.gate().kind).toBe('required');

    verifiedNow.value = true;
    await firstValueFrom(service.completeIfVerified('@a:hs'));
    expect(service.gate()).toEqual({ kind: 'not-required' });
    expect([...store.values()].join()).not.toContain('DEVICE');
  });

  it('treats a record it cannot read as no record', async () => {
    // A record exists for this very device; only reading it fails.
    const store: Store = new Map();
    const first = setup({ store });
    await firstValueFrom(first.service.require('@a:hs', 'DEVICE'));
    TestBed.resetTestingModule();
    expect([...store.values()].join()).toContain('DEVICE');

    const { service, health } = setup({ store, readFails: true });
    await firstValueFrom(service.hydrate('@a:hs'));
    health.set(coherent({ status: 'needs-recovery' }));

    expect(service.gate()).toEqual({ kind: 'not-required' });
  });

  it('keeps the check for this session when the record cannot be saved', async () => {
    const { service, health } = setup({ writeFails: true });
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));
    health.set(coherent({ status: 'needs-recovery' }));

    expect(service.gate()).toEqual({
      kind: 'required',
      status: 'needs-recovery',
    });
  });

  it('refuses to skip in production builds', async () => {
    const { service, health } = setup({ allowSkip: false });
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));
    health.set(coherent({ status: 'needs-recovery' }));

    expect(service.canSkip).toBe(false);
    await expect(firstValueFrom(service.skip())).rejects.toThrow(
      /debug builds/,
    );
    expect(service.gate().kind).toBe('required');
  });

  it('lets a debug build skip, which leaves the device unverified but unblocked', async () => {
    const { service, health } = setup({ allowSkip: true });
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));
    health.set(coherent({ status: 'needs-recovery' }));

    expect(service.canSkip).toBe(true);
    await firstValueFrom(service.skip(), { defaultValue: undefined });

    expect(service.gate()).toEqual({ kind: 'not-required' });
  });

  it('answers at once when the gate is already known', async () => {
    const { service, health } = setup();
    await firstValueFrom(service.hydrate('@a:hs'));
    health.set(coherent({ status: 'needs-recovery' }));
    let answer: DeviceConfirmationGate | undefined;

    service
      .settledGate()
      .subscribe((gate) => (answer = gate))
      .unsubscribe();

    expect(answer).toEqual({ kind: 'not-required' });
  });

  it('settles once trust status arrives', async () => {
    const { service, health } = setup();
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));
    const settled = firstValueFrom(service.settledGate());
    TestBed.tick();
    health.set(coherent({ status: 'needs-recovery' }));
    TestBed.tick();

    await expect(settled).resolves.toEqual({
      kind: 'required',
      status: 'needs-recovery',
    });
  });

  it('confirms a required gate with a fresh read of that exact account', async () => {
    // Just after an account switch, health can still be the previous account's.
    const { service, health, verifiedNow } = setup();
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));
    health.set(coherent({ status: 'needs-recovery' }));
    expect(service.gate().kind).toBe('required');
    await expect(firstValueFrom(service.confirmRequired())).resolves.toBe(true);

    // This account's own read says its device is verified: nothing to act on.
    verifiedNow.value = true;
    await expect(firstValueFrom(service.confirmRequired())).resolves.toBe(
      false,
    );
  });

  it('does not replay a stale settled gate once a new device is recorded', async () => {
    const { service } = setup();
    await firstValueFrom(service.hydrate('@a:hs'));
    await firstValueFrom(service.settledGate());
    TestBed.tick();
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));
    const emitted: DeviceConfirmationGate[] = [];

    service
      .settledGate()
      .subscribe((gate) => emitted.push(gate))
      .unsubscribe();

    expect(emitted).toEqual([]);
  });

  it('answers false when there is nothing to confirm or the read fails', async () => {
    const none = setup();
    await expect(firstValueFrom(none.service.confirmRequired())).resolves.toBe(
      false,
    );
    TestBed.resetTestingModule();

    const other = setup();
    await firstValueFrom(other.service.require('@a:hs', 'OTHER'));
    await expect(firstValueFrom(other.service.confirmRequired())).resolves.toBe(
      false,
    );
    TestBed.resetTestingModule();

    const failing = setup({ localReadFails: true });
    await firstValueFrom(failing.service.require('@a:hs', 'DEVICE'));
    await expect(
      firstValueFrom(failing.service.confirmRequired()),
    ).resolves.toBe(false);
  });

  it('reads the active account, not the one that was recorded', async () => {
    const { service } = setup({ active: '@b:hs' });
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));

    await expect(firstValueFrom(service.confirmRequired())).resolves.toBe(
      false,
    );
  });

  it('ignores an older server answer that lands after a newer sign-in', async () => {
    let calls = 0;
    let answerOld!: (value: unknown) => void;
    const { service, health, store } = setup({
      server: () =>
        ++calls === 1
          ? new Promise((resolve) => {
              answerOld = resolve;
            })
          : Promise.resolve(PUBLISHED),
    });
    const older = firstValueFrom(service.require('@a:hs', 'DEVICE'), {
      defaultValue: undefined,
    });
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));

    answerOld({ master_keys: {} });
    await older;
    health.set(coherent({ status: 'needs-setup' }));

    expect([...store.values()].join()).toContain('DEVICE');
    expect(service.gate()).toEqual({
      kind: 'required',
      status: 'needs-verification',
    });
  });

  it('lets navigation through when trust status never arrives', async () => {
    // RxJS `timeout` schedules through setInterval, so fake that too.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const { service } = setup();
    await firstValueFrom(service.require('@a:hs', 'DEVICE'));
    const settled = firstValueFrom(service.settledGate());
    TestBed.tick();

    await vi.advanceTimersByTimeAsync(DEVICE_CONFIRMATION_SETTLE_MS);

    await expect(settled).resolves.toEqual({ kind: 'not-required' });
  });

  it('keeps the record on this device only, per account, out of config export', () => {
    expect(DEVICE_CONFIRMATION_PREFERENCE).toMatchObject({
      id: 'trust.device-confirmation',
      owner: 'trust',
      scope: 'account',
      storage: 'device-preferences',
      export: 'excluded',
      defaultValue: null,
      persistence: { key: 'trinity.trust.device-confirmation' },
    });
  });
});
