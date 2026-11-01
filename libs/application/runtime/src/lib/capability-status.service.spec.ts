import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import {
  TrustService,
  TrustSlotForecastService,
  type SlotForecast,
  type TrustStatus,
} from '@trinity/data-access/trust';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { BUILD_INFO } from '@trinity/platform-native';
import type { CapabilityRecovery } from '@trinity/runtime/projection';
import { firstValueFrom, of, toArray } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApplicationRuntimeService } from './application-runtime.service';
import type { ApplicationRuntimeState } from './application-runtime.models';
import {
  CAPABILITY_STATUS_CATALOG,
  capabilityStatusCopy,
} from './capability-status.catalog';
import { CapabilityHealthService } from './capability-health.service';
import { CapabilityStatusService } from './capability-status.service';
import { PointerPressService } from './pointer-press.service';
import { healthFact } from './testing/capability-health.fixture';

describe('CapabilityStatusService', () => {
  let health: CapabilityHealthService;
  let status: CapabilityStatusService;
  let runtimeState: WritableSignal<ApplicationRuntimeState>;
  let trust: WritableSignal<TrustStatus>;
  let setupElsewhere: WritableSignal<boolean>;
  let pressed: WritableSignal<boolean>;
  let forecast: WritableSignal<SlotForecast | null>;
  let keyBackupActive: WritableSignal<boolean | null>;
  let storeEncrypted: WritableSignal<boolean | null>;
  let activeUserId: WritableSignal<string | null>;

  beforeEach(() => {
    runtimeState = signal({ phase: 'ready', attempt: 7, settlements: [] });
    trust = signal<TrustStatus>('ready');
    setupElsewhere = signal(false);
    pressed = signal(false);
    forecast = signal<SlotForecast | null>(null);
    keyBackupActive = signal<boolean | null>(true);
    storeEncrypted = signal<boolean | null>(true);
    activeUserId = signal<string | null>('@a:hs');
    TestBed.configureTestingModule({
      providers: [
        CapabilityHealthService,
        CapabilityStatusService,
        {
          provide: TrustService,
          useValue: {
            status: trust,
            recoverySetupElsewhere: setupElsewhere,
            keyBackupActive,
          },
        },
        {
          provide: MatrixClientService,
          useValue: {
            activeUserId,
            cryptoStoreEncrypted: storeEncrypted,
          },
        },
        { provide: PointerPressService, useValue: { pressed } },
        { provide: TrustSlotForecastService, useValue: { forecast } },
        {
          provide: ApplicationRuntimeService,
          useValue: {
            state: runtimeState,
          },
        },
        {
          provide: BUILD_INFO,
          useValue: { version: '1.2.3', commit: 'private', builtAt: 'private' },
        },
        {
          provide: AccountIdentitiesService,
          useValue: {
            identityOf: (id: string) => ({
              userId: id,
              displayName: id === '@a:hs' ? 'Alice' : 'Bob',
              avatarMxc: id === '@a:hs' ? 'mxc://hs/alice' : null,
            }),
          },
        },
      ],
    });
    health = TestBed.inject(CapabilityHealthService);
    status = TestBed.inject(CapabilityStatusService);
  });

  afterEach(() => TestBed.resetTestingModule());

  it('catalogues every current operation and retains a safe generic entry', () => {
    expect(Object.keys(CAPABILITY_STATUS_CATALOG).sort()).toEqual(
      [
        'accounts:restore',
        'badge:support',
        'host:contract',
        'identity:presence',
        'notifications:presentation',
        'notifications:room-rules',
        'preferences:apply-appearance',
        'preferences:hydrate-account-scope',
        'preferences:hydrate-appearance',
        'preferences:hydrate-composer',
        'preferences:hydrate-date-time',
        'preferences:hydrate-feature-flags',
        'preferences:hydrate-gestures',
        'preferences:hydrate-gifs',
        'preferences:hydrate-privacy',
        'preferences:hydrate-mention-inbox',
        'preferences:hydrate-rail-unread',
        'preferences:hydrate-shell-layout',
        'preferences:hydrate-shortcuts',
        'preferences:hydrate-system-lines',
        'push:registration',
        'room-administration:bans',
        'room-administration:members',
        'room-administration:permissions',
        'room-library:hydrate-order',
        'storage:persistence',
        'storage:space',
        'trust:projection',
        'updates:check',
      ].sort(),
    );
    expect(
      capabilityStatusCopy({
        capability: 'new',
        operation: 'future',
        condition: 'degraded',
        code: 'future-private-detail',
      }),
    ).toMatchObject({
      heading: 'A feature needs attention',
      recovery: 'Try again',
      safeDiagnosticReason: 'unrecognized-capability-status',
    });
    expect(
      capabilityStatusCopy({
        capability: 'accounts',
        operation: 'restore',
        condition: 'degraded',
        code: 'account-private-detail',
      }),
    ).toMatchObject({
      heading: 'A feature needs attention',
      safeDiagnosticReason: 'unrecognized-capability-status',
    });
  });

  it('recognises a restore stopped by an unavailable keychain', () => {
    expect(
      capabilityStatusCopy({
        capability: 'accounts',
        operation: 'restore',
        condition: 'degraded',
        code: 'account-restore-secure-storage-unavailable',
      }).safeDiagnosticReason,
    ).toBe('account-restore-secure-storage-unavailable');
  });

  it('recognises a restore that lost its crypto store key', () => {
    expect(
      capabilityStatusCopy({
        capability: 'accounts',
        operation: 'restore',
        condition: 'degraded',
        code: 'account-restore-crypto-store-key-lost',
      }).safeDiagnosticReason,
    ).toBe('account-restore-crypto-store-key-lost');
  });

  it('lists independent startup blockers in dependency order', () => {
    runtimeState.set({
      phase: 'blocked',
      attempt: 8,
      failure: {
        stage: 'session-capabilities',
        recovery: 'retry-startup',
        diagnostic: { code: 'room-library-projection-preparation-failed' },
      },
      settlements: [
        {
          producer: 'browser-storage-persistence',
          stage: 'session-capabilities',
          status: 'blocked',
        },
        {
          producer: 'host-contract',
          stage: 'host-negotiation',
          status: 'blocked',
        },
        {
          producer: 'room-library',
          stage: 'session-capabilities',
          status: 'blocked',
        },
      ],
    });
    expect(status.startupBlockers().map(({ producer }) => producer)).toEqual([
      'host-contract',
      'room-library',
      'browser-storage-persistence',
    ]);
    expect(status.startupRecovery()).toBe('Retry startup');
    expect(status.actionableCount()).toBe(3);
  });

  it('offers account removal beside retry when the keychain blocks startup', () => {
    runtimeState.set({
      phase: 'blocked',
      attempt: 1,
      failure: {
        stage: 'account-restoration',
        recovery: 'retry-startup',
        secondaryRecovery: 'reauthenticate',
        diagnostic: { code: 'account-secure-storage-unavailable' },
      },
      settlements: [],
    });

    expect(status.startupRecovery()).toBe('Retry startup');
    expect(status.startupSecondaryRecovery()).toBe('Remove account');
  });

  it('counts distinct actionable scopes and groups view-only Account identities', () => {
    const firstContext = report('@a:hs', 'accounts', 'restore');
    report('@b:hs', 'accounts', 'restore');
    report('@a:hs', 'room-library', 'hydrate-order');
    health.report(
      healthFact({
        capability: 'accounts',
        operation: 'restore',
        context: firstContext,
        generation: 2,
        code: 'account-restore-transient-network',
      }),
      () => of({ kind: 'success' as const }),
    );
    expect(status.actionableCount()).toBe(3);
    expect(
      status
        .groups()
        .find(({ capability }) => capability === 'Accounts')
        ?.entries.map(({ account }) => account?.name),
    ).toEqual(['Alice', 'Bob']);

    const expected = Symbol();
    health.report(
      {
        capability: 'push',
        operation: 'registration',
        context: expected,
        generation: 1,
        demanded: false,
        preparation: 'acknowledged',
        ownership: 'released',
        condition: 'not-applicable',
        code: 'push-registration-not-configured',
      },
      () => of({ kind: 'unavailable' as const }),
    );
    expect(status.actionableCount()).toBe(3);
  });

  it('suppresses one occurrence but resurfaces recurrence and failed recovery', async () => {
    const context = report('@a:hs', 'accounts', 'restore', () =>
      of({ kind: 'failure' as const }),
    );
    const entry = status.visibleEntries()[0]!;
    status.dismiss(entry);
    expect(status.visibleEntries()).toHaveLength(0);

    await firstValueFrom(health.recover(entry.problem).pipe(toArray()));
    expect(status.visibleEntries()).toHaveLength(1);
    status.dismiss(status.visibleEntries()[0]!);
    health.report(
      {
        ...entry.problem,
        context,
        generation: 2,
        condition: 'available',
        code: 'account-restore-ready',
      },
      () => of({ kind: 'success' as const }),
    );
    health.report(
      {
        ...entry.problem,
        context,
        generation: 3,
        condition: 'degraded',
        code: 'account-restore-crypto-failure',
      },
      () => of({ kind: 'success' as const }),
    );
    expect(status.visibleEntries()).toHaveLength(1);
  });

  it('resurfaces a materially different failure at the same severity', () => {
    const context = report('@a:hs', 'accounts', 'restore');
    const entry = status.visibleEntries()[0]!;
    status.dismiss(entry);
    health.report(
      {
        ...entry.problem,
        context,
        generation: 2,
        code: 'account-restore-crypto-failure',
      },
      () => of({ kind: 'success' as const }),
    );
    expect(status.visibleEntries()).toHaveLength(1);
    expect(status.visibleEntries()[0]?.problem.occurrence).toBe(2);
  });

  it('exports only the explicit safe support-detail fields', () => {
    report('@a:hs', 'accounts', 'restore');
    const details = status.supportDetails();
    expect(details).toContain('"attempt": 7');
    expect(details).toContain('"version": "1.2.3"');
    expect(details).not.toContain('@a:hs');
    expect(details).not.toContain('Alice');
    expect(details).not.toContain('mxc://');
    expect(details).not.toContain('private');
  });

  it('labels the support details of a tab waiting for another tab as startup', () => {
    runtimeState.set({
      phase: 'waiting-for-session',
      attempt: 3,
      settlements: [],
    });
    report('@a:hs', 'accounts', 'restore');

    const details = status.supportDetails();

    expect(details).toContain('"stage": "startup"');
    expect(details).toContain('"attempt": 3');
  });

  it('announces genuine recovery but not duplicates or expected-state retirement', () => {
    const context = report('@a:hs', 'accounts', 'restore');
    const problem = status.entries()[0]!.problem;
    health.report(problem, () => of({ kind: 'success' as const }));
    expect(status.recoveryAnnouncement()).toBe('');

    health.report(
      {
        ...problem,
        context,
        generation: 2,
        demanded: false,
        condition: 'disabled',
        code: 'not-configured',
      },
      () => of({ kind: 'unavailable' as const }),
    );
    expect(status.recoveryAnnouncement()).toBe('');

    health.report(
      {
        ...problem,
        context,
        generation: 3,
        condition: 'degraded',
        code: 'account-restore-crypto-failure',
      },
      () => of({ kind: 'success' as const }),
    );
    health.report(
      {
        ...problem,
        context,
        generation: 4,
        condition: 'available',
        code: 'account-restore-ready',
      },
      () => of({ kind: 'success' as const }),
    );
    expect(status.recoveryAnnouncement()).toBe('Accounts recovered.');
  });

  describe('global banner slot', () => {
    it('holds a slot change while a pointer is pressed and applies it on release', () => {
      report('@a:hs', 'accounts', 'restore');
      expect(status.bannerSlot()).toBe('status');

      pressed.set(true);
      trust.set('needs-setup');
      TestBed.tick();
      expect(status.bannerSlot()).toBe('status');

      pressed.set(false);
      TestBed.tick();
      expect(status.bannerSlot()).toBe('encryption');
    });

    it('changes at once when nothing is pressed', () => {
      trust.set('needs-setup');
      TestBed.tick();
      expect(status.bannerSlot()).toBe('encryption');
    });

    it('is empty when nothing is limited and encryption needs nothing', () => {
      expect(status.bannerSlot()).toBeNull();
      expect(status.bannerMessage()).toBe('');
    });

    it('offers the encryption prompt when it is the only thing to say', () => {
      trust.set('needs-setup');
      expect(status.bannerSlot()).toBe('encryption');
      trust.set('needs-recovery');
      expect(status.bannerSlot()).toBe('encryption');
      trust.set('needs-verification');
      expect(status.bannerSlot()).toBe('encryption');
    });

    it('does not let guidance for another device outrank a limited capability', () => {
      // Verified here, but recovery can only be set up on the device that holds the
      // identity: there is no setup step on this device, so the slot is not claimed as one.
      trust.set('needs-setup');
      setupElsewhere.set(true);
      expect(status.bannerSlot()).toBe('encryption');

      report('@a:hs', 'accounts', 'restore');
      expect(status.bannerSlot()).toBe('status');
    });

    it('lets the encryption prompt outrank a limited capability but not a blocking one', () => {
      report('@a:hs', 'accounts', 'restore');
      expect(status.bannerSlot()).toBe('status');

      trust.set('needs-setup');
      expect(status.bannerSlot()).toBe('encryption');

      reportHostBlocked();
      expect(status.hasBlocking()).toBe(true);
      expect(status.bannerSlot()).toBe('status');
    });

    describe('sign-in prompt for keys stored unencrypted', () => {
      it('asks only once key backup is on, so signing in again loses no history', () => {
        storeEncrypted.set(false);
        keyBackupActive.set(false);
        expect(status.bannerSlot()).toBeNull();
        keyBackupActive.set(null);
        expect(status.bannerSlot()).toBeNull();

        keyBackupActive.set(true);
        expect(status.bannerSlot()).toBe('sign-in-again');

        storeEncrypted.set(true);
        expect(status.bannerSlot()).toBeNull();
      });

      it('gives way to the encryption prompt but outranks a limited problem', () => {
        storeEncrypted.set(false);
        report('@a:hs', 'accounts', 'restore');
        expect(status.bannerSlot()).toBe('sign-in-again');

        trust.set('needs-recovery');
        expect(status.bannerSlot()).toBe('encryption');
      });

      it('stays dismissed for this account in this session only', () => {
        storeEncrypted.set(false);
        status.dismissSignInAgain();
        expect(status.bannerSlot()).toBeNull();

        activeUserId.set('@b:hs');
        expect(status.bannerSlot()).toBe('sign-in-again');

        activeUserId.set('@a:hs');
        expect(status.bannerSlot()).toBeNull();
      });
    });

    it('reserves the slot height for a prompt only once the notice has held the slot', () => {
      TestBed.tick();
      trust.set('needs-setup');
      TestBed.tick();
      expect(status.bannerSlot()).toBe('encryption');
      expect(status.bannerSlotReserved()).toBe(false);

      trust.set('ready');
      report('@a:hs', 'accounts', 'restore');
      TestBed.tick();
      expect(status.bannerSlot()).toBe('status');
      expect(status.bannerSlotReserved()).toBe(true);

      trust.set('needs-setup');
      TestBed.tick();
      expect(status.bannerSlot()).toBe('encryption');
      expect(status.bannerSlotReserved()).toBe(true);

      // Sticky: the slot can take the notice back at any time, so later prompts keep it.
      trust.set('ready');
      status.dismiss(status.visibleEntries()[0]!);
      TestBed.tick();
      expect(status.bannerSlot()).toBeNull();
      trust.set('needs-recovery');
      TestBed.tick();
      expect(status.bannerSlotReserved()).toBe(true);
    });

    it('claims the slot for a forecast prompt while the live status is unknown', () => {
      trust.set('unknown');
      forecast.set('needs-recovery');
      expect(status.bannerSlot()).toBe('encryption');
      expect(status.bannerPrompt()).toEqual({
        kind: 'needs-recovery',
        placeholder: true,
      });

      trust.set('needs-recovery');
      forecast.set(null); // the service clears it once the live status is known
      expect(status.bannerSlot()).toBe('encryption');
      expect(status.bannerPrompt()).toEqual({
        kind: 'needs-recovery',
        placeholder: false,
      });
    });

    it('names the live prompt it holds the slot for', () => {
      trust.set('needs-setup');
      expect(status.bannerPrompt()).toEqual({
        kind: 'needs-setup',
        placeholder: false,
      });
      trust.set('needs-verification');
      expect(status.bannerPrompt()).toEqual({
        kind: 'needs-verification',
        placeholder: false,
      });
      trust.set('needs-setup');
      setupElsewhere.set(true);
      expect(status.bannerPrompt()).toEqual({
        kind: 'setup-elsewhere',
        placeholder: false,
      });
    });

    it('holds no prompt while the slot holds the status notice or nothing', () => {
      expect(status.bannerPrompt()).toBeNull();
      trust.set('needs-setup');
      reportHostBlocked();
      expect(status.bannerSlot()).toBe('status');
      expect(status.bannerPrompt()).toBeNull();
    });

    it('lets a forecast outrank a limited capability, as the live prompt would', () => {
      report('@a:hs', 'accounts', 'restore');
      trust.set('unknown');
      forecast.set('needs-setup');
      expect(status.bannerSlot()).toBe('encryption');
    });

    it('does not let a forecast of guidance for another device outrank a limited capability', () => {
      report('@a:hs', 'accounts', 'restore');
      trust.set('unknown');
      forecast.set('setup-elsewhere');
      expect(status.bannerSlot()).toBe('status');
      expect(status.bannerPrompt()).toBeNull();
    });

    it('releases the slot when the live status is ready', () => {
      trust.set('unknown');
      forecast.set('needs-setup');
      trust.set('ready');
      forecast.set(null);
      expect(status.bannerSlot()).toBeNull();
      expect(status.bannerPrompt()).toBeNull();
    });

    it('drops the forecast at once when Trust reports a failure, so the notice shows', () => {
      trust.set('unknown');
      forecast.set('needs-setup');
      expect(status.bannerSlot()).toBe('encryption');

      reportTrustFailure();

      expect(status.bannerSlot()).toBe('status');
      expect(status.bannerPrompt()).toBeNull();
      expect(status.bannerMessage()).toBe(
        'Encryption trust status is unavailable.',
      );
    });

    it('gives the slot to the trust failure notice over a stale snapshot’s prompt', () => {
      // Mid-session read failure: the live status is unknown (only a stale snapshot is
      // left) and Trust reports the failure. Whatever is forecast, the notice shows.
      trust.set('unknown');
      forecast.set('needs-setup');
      reportTrustFailure();

      expect(status.bannerSlot()).toBe('status');
      expect(status.bannerPrompt()).toBeNull();
    });

    it('does not bring the forecast back when the trust failure notice is dismissed', () => {
      trust.set('unknown');
      forecast.set('needs-recovery');
      reportTrustFailure();
      status.dismiss(status.visibleEntries()[0]!);

      expect(status.bannerSlot()).toBeNull();
      expect(status.bannerPrompt()).toBeNull();
    });

    describe('while a pointer is pressed', () => {
      /** Press with the slot already decided, as a tap on the page would. */
      function press(): void {
        TestBed.tick();
        pressed.set(true);
        TestBed.tick();
      }

      function release(): void {
        pressed.set(false);
        TestBed.tick();
      }

      it('holds the forecast prompt’s kind when the forecast changes kind', () => {
        trust.set('unknown');
        forecast.set('needs-setup');
        press();

        forecast.set('needs-recovery');
        expect(status.bannerSlot()).toBe('encryption');
        expect(status.bannerPrompt()).toEqual({
          kind: 'needs-setup',
          placeholder: true,
        });

        release();
        expect(status.bannerPrompt()).toEqual({
          kind: 'needs-recovery',
          placeholder: true,
        });
      });

      it('keeps the forecast prompt’s placeholder when the live status turns out ready', () => {
        trust.set('unknown');
        forecast.set('needs-recovery');
        press();

        trust.set('ready');
        forecast.set(null);
        expect(status.bannerSlot()).toBe('encryption');
        expect(status.bannerPrompt()).toEqual({
          kind: 'needs-recovery',
          placeholder: true,
        });

        release();
        expect(status.bannerSlot()).toBeNull();
        expect(status.bannerPrompt()).toBeNull();
      });

      it('keeps the forecast prompt’s placeholder when the forecast expires', () => {
        trust.set('unknown');
        forecast.set('needs-setup');
        press();

        forecast.set(null); // FORECAST_HOLD_MS passed with no live status
        expect(status.bannerSlot()).toBe('encryption');
        expect(status.bannerPrompt()).toEqual({
          kind: 'needs-setup',
          placeholder: true,
        });

        release();
        expect(status.bannerSlot()).toBeNull();
        expect(status.bannerPrompt()).toBeNull();
      });

      it('reveals a confirmed forecast prompt only on release', () => {
        trust.set('unknown');
        forecast.set('needs-recovery');
        press();

        trust.set('needs-recovery');
        forecast.set(null);
        expect(status.bannerPrompt()).toEqual({
          kind: 'needs-recovery',
          placeholder: true,
        });

        release();
        expect(status.bannerPrompt()).toEqual({
          kind: 'needs-recovery',
          placeholder: false,
        });
      });

      it('hides a shown prompt the live status no longer supports, keeping its kind until release', () => {
        trust.set('needs-setup');
        press();
        expect(status.bannerPrompt()).toEqual({
          kind: 'needs-setup',
          placeholder: false,
        });

        trust.set('ready');
        expect(status.bannerSlot()).toBe('encryption');
        expect(status.bannerPrompt()).toEqual({
          kind: 'needs-setup',
          placeholder: true,
        });

        release();
        expect(status.bannerSlot()).toBeNull();
        expect(status.bannerPrompt()).toBeNull();
      });

      it('holds a shown prompt’s kind when the live status changes kind', () => {
        trust.set('needs-setup');
        press();

        trust.set('needs-recovery');
        expect(status.bannerPrompt()).toEqual({
          kind: 'needs-setup',
          placeholder: true,
        });

        release();
        expect(status.bannerPrompt()).toEqual({
          kind: 'needs-recovery',
          placeholder: false,
        });
      });

      it('keeps a shown prompt the live status still supports', () => {
        trust.set('needs-setup');
        press();

        reportHostBlocked();
        // The slot change waits for the release; the prompt it holds is still true.
        expect(status.bannerSlot()).toBe('encryption');
        expect(status.bannerPrompt()).toEqual({
          kind: 'needs-setup',
          placeholder: false,
        });

        release();
        expect(status.bannerSlot()).toBe('status');
        expect(status.bannerPrompt()).toBeNull();
      });
    });

    it('names the limited capability instead of counting it', () => {
      report('@a:hs', 'accounts', 'restore');
      expect(status.bannerMessage()).toBe(
        'A background Account needs attention.',
      );

      report('@a:hs', 'room-library', 'hydrate-order');
      expect(status.bannerMessage()).toBe('Limited: Accounts and Rooms.');
    });

    it('abbreviates three or more capabilities', () => {
      report('@a:hs', 'accounts', 'restore');
      report('@a:hs', 'room-library', 'hydrate-order');
      report('@a:hs', 'identity', 'presence');
      expect(status.bannerMessage()).toBe(
        'Limited: Accounts, Rooms and 1 more.',
      );
    });
  });

  /** Trust's projection failed for the active Account, as TrustLifetime reports it. */
  function reportTrustFailure(): void {
    const context = Symbol('@a:hs');
    health.presentForAccount(context, '@a:hs');
    health.report(
      healthFact({
        capability: 'trust',
        operation: 'projection',
        context,
        code: 'trust-reconciliation-failed',
      }),
      () => of({ kind: 'success' as const }),
    );
  }

  /** The host contract is unavailable, which blocks rather than limits. */
  function reportHostBlocked(): void {
    health.report(
      healthFact({
        capability: 'host',
        operation: 'contract',
        context: Symbol('host'),
        condition: 'blocked',
        code: 'host-contract-unavailable',
      }),
      () => of({ kind: 'success' as const }),
    );
  }

  function report(
    accountId: string,
    capability: string,
    operation: string,
    recovery: CapabilityRecovery = () => of({ kind: 'success' as const }),
  ): symbol {
    const context = Symbol(accountId);
    health.presentForAccount(context, accountId);
    health.report(
      healthFact({
        capability,
        operation,
        context,
        code:
          capability === 'accounts'
            ? 'account-restore-transient-network'
            : 'room-order-storage-unavailable',
      }),
      recovery,
    );
    return context;
  }
});
