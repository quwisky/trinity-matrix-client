import { Location } from '@angular/common';
import { ApplicationRef, Injectable, inject } from '@angular/core';
import {
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  Router,
} from '@angular/router';
import type { ApplicationRuntimeAdapter } from '../application-runtime.adapter';
import type {
  ApplicationRecoveryAdapterOutcome,
  ApplicationSessionEvent,
  ApplicationSessionLockOutcome,
  ApplicationStartupProducerSettlement,
  ApplicationStartupRecovery,
  ApplicationStartupStageOutcome,
} from '../application-runtime.models';
import { APPLICATION_STARTUP_PRODUCER_POLICIES } from '../application-startup.policy';
import { AppearanceEffects } from '@trinity/application/appearance';
import {
  AccountRuntimeService,
  type AccountRestoreResult,
} from '@trinity/data-access/accounts';
import { RetiredPushGatewayCleanup } from '@trinity/data-access/notifications';
import {
  AppConfigService,
  DraftStoreService,
  SESSION_LOCK_REQUIRED,
  SessionLockService,
  StoragePersistenceService,
} from '@trinity/platform-native';
import {
  HostCapabilitiesService,
  type HostCapabilityManifest,
} from '@trinity/runtime/host';
import type {
  CapabilityContext,
  CapabilityRecoveryOutcome,
} from '@trinity/runtime/projection';
import {
  Observable,
  Subject,
  TimeoutError,
  EMPTY,
  catchError,
  concat,
  defaultIfEmpty,
  defer,
  filter,
  forkJoin,
  from,
  ignoreElements,
  map,
  of,
  switchMap,
  take,
  takeUntil,
  timeout,
} from 'rxjs';
import { AccountStartupHealthService } from './account-startup-health.service';
import { PreferenceStartupHealthService } from './preference-startup-health.service';
import { PreferenceEffectHealthService } from './preference-effect-health.service';
import { RoomOrderHealthService } from './room-order-health.service';
import {
  optionalProducerDegraded,
  optionalProducerReady,
} from './optional-startup-outcome';
import { TrinityApplicationSessionAdapter } from './trinity-application-session.adapter';
import { TrinityPreferenceStartupSources } from './trinity-preference-startup-sources';
import { HostSessionHealthService } from './host-session-health.service';
import { CapabilityHealthService } from '../capability-health.service';

const ready = (
  settlements: readonly ApplicationStartupProducerSettlement[] = [],
): ApplicationStartupStageOutcome => ({
  kind: 'ready',
  ...(settlements.length > 0 ? { settlements } : {}),
});

/**
 * How long the session-lock stage waits for the saved Appearance (local reads) before it asks
 * for the lock anyway: the stage has no deadline, so a stuck read must not hold startup.
 */
const SAVED_APPEARANCE_BUDGET_MS = 500;

const navigationFailed = {
  kind: 'blocked',
  recovery: 'retry-startup',
  diagnostic: { code: 'workspace-navigation-failed' },
} as const satisfies ApplicationStartupStageOutcome;

@Injectable({ providedIn: 'root' })
export class TrinityApplicationRuntimeAdapter implements ApplicationRuntimeAdapter {
  private readonly applicationRef = inject(ApplicationRef);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly host = inject(HostCapabilitiesService);
  private readonly accounts = inject(AccountRuntimeService);
  private readonly session = inject(TrinityApplicationSessionAdapter);
  private readonly drafts = inject(DraftStoreService);
  private readonly retiredPushGateway = inject(RetiredPushGatewayCleanup);
  private readonly appConfig = inject(AppConfigService);
  private readonly storagePersistence = inject(StoragePersistenceService);
  private readonly accountHealth = inject(AccountStartupHealthService);
  private readonly preferenceHealth = inject(PreferenceStartupHealthService);
  private readonly preferenceEffects = inject(PreferenceEffectHealthService);
  private readonly roomOrderHealth = inject(RoomOrderHealthService);
  private readonly preferenceSources = inject(TrinityPreferenceStartupSources);
  private readonly hostHealth = inject(HostSessionHealthService);
  private readonly health = inject(CapabilityHealthService);
  private readonly sessionLock = inject(SessionLockService);
  private readonly sessionLockRequired = inject(SESSION_LOCK_REQUIRED);
  private readonly appearance = inject(AppearanceEffects);
  private savedAppearanceApplied = false;
  private readonly healthContexts = new Map<string, CapabilityContext>();
  // Version stamped into CapabilityHealthFact.generation and compared by recover(); not a latest-wins guard.
  private readonly healthGenerations = new Map<string, number>();
  private manifest: HostCapabilityManifest | null = null;
  private accountRecoveryId: string | null = null;
  private preferenceResetAttempt: number | null = null;
  private workspaceNavigationStarted = false;
  private workspaceUrl: string | null = null;
  /** Emits when a Workspace restoration starts; releases the one it supersedes. */
  private readonly workspaceRestorations = new Subject<void>();

  negotiateHost(): Observable<ApplicationStartupStageOutcome> {
    return this.host.manifest().pipe(
      map((manifest) => {
        this.manifest = manifest;
        const protocolMismatch = Object.values(manifest.operations).some(
          (support) =>
            support.kind === 'unavailable' &&
            support.reason === 'protocol-mismatch',
        );
        this.reportHostContract(protocolMismatch);
        return ready();
      }),
      catchError(() =>
        of({
          kind: 'blocked',
          recovery: 'retry-startup',
          diagnostic: { code: 'host-negotiation-failed' },
        } as const),
      ),
    );
  }

  acquireSessionLock(): Observable<ApplicationSessionLockOutcome> {
    return concat(
      this.applySavedAppearance(),
      defer(() => this.acquireLock()),
    );
  }

  /**
   * A browser tab may stop on a notice (another tab, or no secure connection) before
   * preferences hydrate, so it shows the user's saved Appearance first. Read-only and once;
   * Electron and native apps take no lock and keep their usual startup.
   */
  private applySavedAppearance(): Observable<never> {
    return defer(() => {
      if (!this.sessionLockRequired || this.savedAppearanceApplied) {
        return EMPTY;
      }
      this.savedAppearanceApplied = true;
      return this.appearance.applySaved().pipe(
        timeout({ first: SAVED_APPEARANCE_BUDGET_MS, with: () => EMPTY }),
        ignoreElements(),
        catchError(() => EMPTY),
      );
    });
  }

  private acquireLock(): Observable<ApplicationSessionLockOutcome> {
    return this.sessionLock.acquire().pipe(
      map((acquisition): ApplicationSessionLockOutcome => {
        switch (acquisition) {
          case 'held':
          case 'not-required':
            return { kind: 'held' };
          case 'waiting':
            return { kind: 'waiting' };
          case 'unavailable':
            return { kind: 'unavailable' };
          default: {
            const unhandled: never = acquisition;
            void unhandled;
            return { kind: 'unavailable' };
          }
        }
      }),
      // Never start without the lock.
      catchError(() => of({ kind: 'unavailable' } as const)),
    );
  }

  awaitSessionLock(): Observable<void> {
    return this.sessionLock.granted();
  }

  hydratePreferences(): Observable<ApplicationStartupStageOutcome> {
    return forkJoin({
      preferences: this.preferenceHealth.hydrate(
        this.preferenceSources.sources(),
      ),
      // Drafts are deliberately outside preference policy and the exported reset catalogue.
      drafts: defer(() => from(this.drafts.init())).pipe(
        catchError(() => of(void 0)),
      ),
      // Keys from the retired push gateway setting; never read, deleted before anything runs.
      retiredPushGateway: this.retiredPushGateway.run(),
    }).pipe(map(({ preferences }) => preferences));
  }

  restoreAccounts(): Observable<ApplicationStartupStageOutcome> {
    return this.accounts.restoreSavedAccounts().pipe(
      map((result) => {
        this.accountHealth.report(result.accounts);
        this.accountRecoveryId =
          result.kind === 'active-account-unavailable'
            ? result.activeAccountId
            : null;
        switch (result.kind) {
          case 'no-accounts':
          case 'restored':
            return ready();
          case 'restored-with-inactive-failures':
            return ready();
          case 'active-account-unavailable':
            // A locked keychain is an outage: retrying after unlocking it opens the
            // Account. Offering removal there would delete a store that is fine.
            if (activeFailure(result) === 'secure-storage-unavailable') {
              // Removal stays reachable as a confirmed second choice: a key that is truly
              // gone but reads as unavailable (no keyring, a replaced one, an invalidated
              // Keystore) would otherwise leave only retries. It is never run on its own.
              return {
                kind: 'blocked',
                recovery: 'retry-startup',
                secondaryRecovery: 'reauthenticate',
                diagnostic: { code: 'account-secure-storage-unavailable' },
              } as const;
            }
            return {
              kind: 'blocked',
              recovery: 'reauthenticate',
              diagnostic: { code: 'active-account-unavailable' },
            } as const;
          case 'local-state-unavailable':
            return {
              kind: 'blocked',
              recovery: 'reset-installation',
              diagnostic: { code: 'account-local-state-unavailable' },
            } as const;
          case 'transition-in-progress':
            return {
              kind: 'blocked',
              recovery: 'retry-startup',
              diagnostic: { code: 'account-transition-in-progress' },
            } as const;
        }
      }),
      catchError(() =>
        of({
          kind: 'blocked',
          recovery: 'retry-startup',
          diagnostic: { code: 'account-restoration-failed' },
        } as const),
      ),
    );
  }

  establishSessionCapabilities(): Observable<ApplicationStartupStageOutcome> {
    return defer(() => {
      const badgeSupport = this.manifest?.operations.badge;
      if (badgeSupport) this.hostHealth.badgeSupport(badgeSupport);
      const persistence =
        APPLICATION_STARTUP_PRODUCER_POLICIES['browser-storage-persistence'];
      return forkJoin({
        ordering: this.roomOrderHealth
          .hydrate()
          .pipe(
            map((outcome) =>
              outcome.kind === 'ready'
                ? optionalProducerReady('room-order')
                : optionalProducerDegraded(
                    'room-order',
                    'room-order-hydration-degraded',
                  ),
            ),
          ),
        persistence: defer(() =>
          this.storagePersistence.offered()
            ? this.storagePersistence.requestPersistence()
            : of(null),
        ).pipe(
          timeout({ first: persistence.budgetMs }),
          map((persisted) =>
            persisted === null
              ? this.storageNotOffered()
              : persisted
                ? this.storageReady()
                : this.storageDegraded('storage-persistence-denied'),
          ),
          defaultIfEmpty(
            this.storageDegraded('storage-persistence-unavailable'),
          ),
          catchError((error: unknown) =>
            of(
              this.storageDegraded(
                error instanceof TimeoutError
                  ? persistence.timeoutCode
                  : 'storage-persistence-unavailable',
              ),
            ),
          ),
        ),
        space: defer(() => this.storagePersistence.spaceLow()).pipe(
          timeout({ first: persistence.budgetMs }),
          // An estimate that never answers says nothing about space, so report nothing.
          map((low) => this.reportSpace(low)),
          catchError(() => of(undefined)),
        ),
      }).pipe(
        map(({ ordering, persistence }) =>
          ready([ordering.settlement, persistence.settlement]),
        ),
      );
    });
  }

  restoreWorkspace(): Observable<ApplicationStartupStageOutcome> {
    return defer(() => {
      this.workspaceUrl ??= this.location.path(true) || '/';
      this.workspaceRestorations.next();
      let navigation: Observable<boolean>;
      if (!this.workspaceNavigationStarted) {
        this.workspaceNavigationStarted = true;
        navigation = this.boundInitialNavigation(
          this.initialWorkspaceNavigation(),
        );
      } else {
        navigation = this.navigateWorkspace(this.workspaceUrl);
      }
      return navigation.pipe(
        take(1),
        switchMap((navigated) =>
          navigated
            ? of(ready())
            : this.navigateWorkspace('/').pipe(
                map((fallback) =>
                  fallback ? this.workspaceFallback() : navigationFailed,
                ),
              ),
        ),
        takeUntil(this.workspaceRestorations),
        defaultIfEmpty(navigationFailed),
      );
    });
  }

  awaitReadiness(): Observable<ApplicationStartupStageOutcome> {
    return this.applicationRef.isStable.pipe(
      filter(Boolean),
      take(1),
      map(() => ready()),
    );
  }

  recover(
    recovery: ApplicationStartupRecovery,
  ): Observable<ApplicationRecoveryAdapterOutcome> {
    switch (recovery) {
      case 'retry-startup':
        return of({ kind: 'ready' });
      case 'reset-preferences':
        return defer(() =>
          this.preferenceResetAttempt === null
            ? this.appConfig.resetToDefaults()
            : this.appConfig.retryResetToDefaults(this.preferenceResetAttempt),
        ).pipe(
          map((outcome): ApplicationRecoveryAdapterOutcome => {
            if (outcome.kind === 'completed') {
              this.preferenceResetAttempt = null;
              return { kind: 'ready' };
            }
            if (outcome.kind === 'partial') {
              this.preferenceResetAttempt = outcome.attempt;
            }
            return { kind: 'unavailable', reason: 'recovery-failed' };
          }),
          catchError(() =>
            of({ kind: 'unavailable', reason: 'recovery-failed' } as const),
          ),
        );
      case 'reauthenticate':
        return defer(() => {
          const accountId =
            this.accounts.activeAccountId() ?? this.accountRecoveryId;
          if (!accountId) return of({ kind: 'ready' } as const);
          return this.accounts.signOutAccount(accountId).pipe(
            map((outcome): ApplicationRecoveryAdapterOutcome => {
              if (outcome.kind === 'ready') {
                this.accountRecoveryId = null;
                return { kind: 'ready' };
              }
              if (outcome.kind === 'uncertain-cleanup') {
                return {
                  kind: 'unavailable',
                  reason: 'cleanup-in-progress',
                  cleanup: {
                    issues: outcome.issues,
                    pending: outcome.pending,
                  },
                };
              }
              if (outcome.kind === 'partial-cleanup') {
                return {
                  kind: 'unavailable',
                  reason: 'partial-cleanup',
                  cleanup: { issues: outcome.issues },
                };
              }
              return {
                kind: 'unavailable',
                reason:
                  outcome.kind === 'transition-in-progress'
                    ? 'transition-in-progress'
                    : 'recovery-failed',
              };
            }),
          );
        });
      case 'reset-installation':
        return this.accounts.resetInstallation().pipe(
          map((outcome): ApplicationRecoveryAdapterOutcome => {
            if (outcome.kind === 'transition-in-progress') {
              return { kind: 'unavailable', reason: 'transition-in-progress' };
            }
            if (outcome.kind === 'uncertain-cleanup') {
              return {
                kind: 'unavailable',
                reason: 'cleanup-in-progress',
                cleanup: {
                  issues: outcome.issues,
                  pending: outcome.pending,
                },
              };
            }
            if (outcome.kind === 'partial-cleanup') {
              return {
                kind: 'unavailable',
                reason: 'partial-cleanup',
                cleanup: { issues: outcome.issues },
              };
            }
            this.accountRecoveryId = null;
            return { kind: 'ready' };
          }),
          catchError(() =>
            of({ kind: 'unavailable', reason: 'recovery-failed' } as const),
          ),
        );
    }
  }

  runSession(readiness: Observable<void>): Observable<ApplicationSessionEvent> {
    return this.session.run(readiness);
  }

  runPreferenceLifetime(): Observable<never> {
    return this.preferenceEffects.run();
  }

  private reportHostContract(protocolMismatch: boolean): void {
    this.reportHealth(
      'host',
      'contract',
      protocolMismatch ? 'degraded' : 'available',
      protocolMismatch ? 'host-protocol-mismatch' : 'host-contract-ready',
      () =>
        this.host.manifest().pipe(
          take(1),
          map((manifest): CapabilityRecoveryOutcome => {
            this.manifest = manifest;
            const mismatch = Object.values(manifest.operations).some(
              (support) =>
                support.kind === 'unavailable' &&
                support.reason === 'protocol-mismatch',
            );
            this.reportHostContract(mismatch);
            return mismatch ? { kind: 'failure' } : { kind: 'success' };
          }),
          catchError(() => of({ kind: 'failure' } as const)),
        ),
    );
  }

  private storageReady() {
    this.reportStorage('available', 'storage-persistence-ready');
    return optionalProducerReady('browser-storage-persistence');
  }

  /** The host can never grant persistence (the iOS app): nothing to warn about or retry. */
  private storageNotOffered() {
    this.reportStorage('not-applicable', 'storage-persistence-not-offered');
    return optionalProducerReady('browser-storage-persistence');
  }

  private storageDegraded(code: string) {
    this.reportStorage('degraded', code);
    return optionalProducerDegraded('browser-storage-persistence', code);
  }

  private reportStorage(
    condition: 'available' | 'degraded' | 'not-applicable',
    code: string,
  ): void {
    this.reportHealth('storage', 'persistence', condition, code, () =>
      defer(() => this.storagePersistence.requestPersistence()).pipe(
        take(1),
        map((persisted): CapabilityRecoveryOutcome => {
          if (persisted) {
            this.reportStorage('available', 'storage-persistence-ready');
            return { kind: 'success' };
          }
          this.reportStorage('degraded', 'storage-persistence-denied');
          return { kind: 'failure' };
        }),
        catchError(() => of({ kind: 'failure' } as const)),
      ),
    );
  }

  private reportSpace(low: boolean): void {
    this.reportHealth(
      'storage',
      'space',
      low ? 'degraded' : 'available',
      low ? 'storage-space-low' : 'storage-space-ready',
      () =>
        defer(() => this.storagePersistence.spaceLow()).pipe(
          map((stillLow): CapabilityRecoveryOutcome => {
            this.reportSpace(stillLow);
            return { kind: stillLow ? 'failure' : 'success' };
          }),
        ),
    );
  }

  private workspaceFallback(): ApplicationStartupStageOutcome {
    this.health.incident({
      context: this.context('workspace:routing'),
      capability: 'workspace',
      operation: 'routing',
      code: 'workspace-safe-root-fallback',
    });
    return ready();
  }

  private reportHealth(
    capability: string,
    operation: string,
    condition: 'available' | 'degraded' | 'not-applicable',
    code: string,
    recovery: () => Observable<CapabilityRecoveryOutcome>,
  ): void {
    const key = `${capability}:${operation}`;
    const generation = (this.healthGenerations.get(key) ?? 0) + 1;
    this.healthGenerations.set(key, generation);
    this.health.report(
      {
        capability,
        operation,
        context: this.context(key),
        generation,
        demanded: condition !== 'not-applicable',
        preparation: condition === 'degraded' ? 'failed' : 'acknowledged',
        ownership: 'released',
        condition,
        code,
      },
      recovery,
    );
  }

  private context(key: string): CapabilityContext {
    const context = this.healthContexts.get(key) ?? Symbol(key);
    this.healthContexts.set(key, context);
    return context;
  }

  private initialWorkspaceNavigation(): Observable<boolean> {
    return new Observable<boolean>((subscriber) => {
      const events = this.router.events
        .pipe(
          filter(
            (event) =>
              event instanceof NavigationEnd ||
              event instanceof NavigationError ||
              event instanceof NavigationSkipped,
          ),
          take(1),
          map(
            (event) =>
              event instanceof NavigationEnd ||
              event instanceof NavigationSkipped,
          ),
        )
        .subscribe(subscriber);
      try {
        this.router.initialNavigation();
      } catch {
        subscriber.next(false);
        subscriber.complete();
      }
      return () => events.unsubscribe();
    });
  }

  private navigateWorkspace(url: string): Observable<boolean> {
    return defer(() =>
      from(this.router.navigateByUrl(url, { replaceUrl: true })),
    ).pipe(
      timeout({
        first: APPLICATION_STARTUP_PRODUCER_POLICIES.workspace.attemptBudgetMs,
        with: () => of(false),
      }),
      catchError(() => of(false)),
    );
  }

  private boundInitialNavigation(
    navigation: Observable<boolean>,
  ): Observable<boolean> {
    return navigation.pipe(
      timeout({
        first: APPLICATION_STARTUP_PRODUCER_POLICIES.workspace.attemptBudgetMs,
        with: () => of(false),
      }),
    );
  }
}

/** The active Account's restore failure, when it failed. */
function activeFailure(result: AccountRestoreResult): string | null {
  const active = result.accounts.find((account) => account.role === 'active');
  return active?.kind === 'failed' ? active.failure : null;
}
