import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
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

describe('CapabilityStatusService', () => {
  let health: CapabilityHealthService;
  let status: CapabilityStatusService;
  let runtimeState: WritableSignal<ApplicationRuntimeState>;

  beforeEach(() => {
    runtimeState = signal({ phase: 'ready', attempt: 7, settlements: [] });
    TestBed.configureTestingModule({
      providers: [
        CapabilityHealthService,
        CapabilityStatusService,
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
        'preferences:hydrate-push-gateway',
        'preferences:hydrate-shell-layout',
        'preferences:hydrate-shortcuts',
        'preferences:hydrate-system-lines',
        'push:registration',
        'room-administration:bans',
        'room-administration:members',
        'room-administration:permissions',
        'room-library:hydrate-order',
        'storage:persistence',
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

  it('counts distinct actionable scopes and groups view-only Account identities', () => {
    const firstContext = report('@a:hs', 'accounts', 'restore');
    report('@b:hs', 'accounts', 'restore');
    report('@a:hs', 'room-library', 'hydrate-order');
    health.report(
      {
        capability: 'accounts',
        operation: 'restore',
        context: firstContext,
        generation: 2,
        demanded: true,
        preparation: 'failed',
        ownership: 'retained',
        condition: 'degraded',
        code: 'account-restore-transient-network',
      },
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

  function report(
    accountId: string,
    capability: string,
    operation: string,
    recovery: CapabilityRecovery = () => of({ kind: 'success' as const }),
  ): symbol {
    const context = Symbol(accountId);
    health.presentForAccount(context, accountId);
    health.report(
      {
        capability,
        operation,
        context,
        generation: 1,
        demanded: true,
        preparation: 'failed',
        ownership: 'retained',
        condition: 'degraded',
        code:
          capability === 'accounts'
            ? 'account-restore-transient-network'
            : 'room-order-storage-unavailable',
      },
      recovery,
    );
    return context;
  }
});
