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
  ApplicationRuntimeWarning,
  ApplicationStartupProducerSettlement,
  ApplicationStartupRecovery,
  ApplicationStartupStageOutcome,
} from '../application-runtime.models';
import { APPLICATION_STARTUP_PRODUCER_POLICIES } from '../application-startup.policy';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import {
  AppConfigService,
  DraftStoreService,
  StoragePersistenceService,
} from '@trinity/platform-native';
import {
  HostCapabilitiesService,
  type HostCapabilityManifest,
} from '@trinity/runtime/host';
import {
  Observable,
  TimeoutError,
  catchError,
  defaultIfEmpty,
  defer,
  filter,
  forkJoin,
  from,
  map,
  of,
  switchMap,
  take,
  timeout,
} from 'rxjs';
import { AccountStartupHealthService } from './account-startup-health.service';
import { PreferenceStartupHealthService } from './preference-startup-health.service';
import { PreferenceEffectHealthService } from './preference-effect-health.service';
import { RoomOrderHealthService } from './room-order-health.service';
import {
  optionalProducerDegraded,
  optionalProducerHealthDegraded,
  optionalProducerReady,
} from './optional-startup-outcome';
import { TrinityApplicationSessionAdapter } from './trinity-application-session.adapter';
import { TrinityPreferenceStartupSources } from './trinity-preference-startup-sources';
import { HostSessionHealthService } from './host-session-health.service';

const ready = (
  warnings: readonly ApplicationRuntimeWarning[] = [],
  settlements: readonly ApplicationStartupProducerSettlement[] = [],
): ApplicationStartupStageOutcome => ({
  kind: 'ready',
  ...(warnings.length > 0 ? { warnings } : {}),
  ...(settlements.length > 0 ? { settlements } : {}),
});

const warning = (
  stage: ApplicationRuntimeWarning['stage'],
  scope: ApplicationRuntimeWarning['scope'],
  code: string,
): ApplicationRuntimeWarning => ({
  stage,
  scope,
  diagnostic: { code },
  recovery: 'retry-startup',
});

@Injectable({ providedIn: 'root' })
export class TrinityApplicationRuntimeAdapter implements ApplicationRuntimeAdapter {
  private readonly applicationRef = inject(ApplicationRef);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly host = inject(HostCapabilitiesService);
  private readonly accounts = inject(AccountRuntimeService);
  private readonly session = inject(TrinityApplicationSessionAdapter);
  private readonly drafts = inject(DraftStoreService);
  private readonly appConfig = inject(AppConfigService);
  private readonly storagePersistence = inject(StoragePersistenceService);
  private readonly accountHealth = inject(AccountStartupHealthService);
  private readonly preferenceHealth = inject(PreferenceStartupHealthService);
  private readonly preferenceEffects = inject(PreferenceEffectHealthService);
  private readonly roomOrderHealth = inject(RoomOrderHealthService);
  private readonly preferenceSources = inject(TrinityPreferenceStartupSources);
  private readonly hostHealth = inject(HostSessionHealthService);
  private manifest: HostCapabilityManifest | null = null;
  private accountRecoveryId: string | null = null;
  private preferenceResetAttempt: number | null = null;
  private workspaceNavigationStarted = false;
  private workspaceUrl: string | null = null;
  private workspaceNavigationGeneration = 0;

  negotiateHost(): Observable<ApplicationStartupStageOutcome> {
    return this.host.manifest().pipe(
      map((manifest) => {
        this.manifest = manifest;
        const protocolMismatch = Object.values(manifest.operations).some(
          (support) =>
            support.kind === 'unavailable' &&
            support.reason === 'protocol-mismatch',
        );
        return ready(
          protocolMismatch
            ? [warning('host-negotiation', 'host', 'host-protocol-mismatch')]
            : [],
        );
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

  hydratePreferences(): Observable<ApplicationStartupStageOutcome> {
    return forkJoin({
      preferences: this.preferenceHealth.hydrate(
        this.preferenceSources.sources(),
      ),
      // Drafts are deliberately outside preference policy and the exported reset catalogue.
      drafts: defer(() => from(this.drafts.init())).pipe(
        catchError(() => of(void 0)),
      ),
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
                : optionalProducerHealthDegraded(
                    'room-order',
                    'room-order-hydration-degraded',
                  ),
            ),
          ),
        persistence: defer(() =>
          this.storagePersistence.requestPersistence(),
        ).pipe(
          timeout({ first: persistence.budgetMs }),
          map((persisted) =>
            persisted
              ? optionalProducerReady('browser-storage-persistence')
              : optionalProducerDegraded(
                  'browser-storage-persistence',
                  warning(
                    'session-capabilities',
                    'storage',
                    'storage-persistence-denied',
                  ),
                ),
          ),
          defaultIfEmpty(
            optionalProducerDegraded(
              'browser-storage-persistence',
              warning(
                'session-capabilities',
                'storage',
                'storage-persistence-unavailable',
              ),
            ),
          ),
          catchError((error: unknown) =>
            of(
              optionalProducerDegraded(
                'browser-storage-persistence',
                warning(
                  'session-capabilities',
                  'storage',
                  error instanceof TimeoutError
                    ? persistence.timeoutCode
                    : 'storage-persistence-unavailable',
                ),
              ),
            ),
          ),
        ),
      }).pipe(
        map(({ ordering, persistence }) =>
          ready(
            [...ordering.warnings, ...persistence.warnings],
            [ordering.settlement, persistence.settlement],
          ),
        ),
      );
    });
  }

  restoreWorkspace(): Observable<ApplicationStartupStageOutcome> {
    return defer(() => {
      this.workspaceUrl ??= this.location.path(true) || '/';
      const generation = ++this.workspaceNavigationGeneration;
      let navigation: Observable<boolean>;
      if (!this.workspaceNavigationStarted) {
        this.workspaceNavigationStarted = true;
        navigation = this.boundInitialNavigation(
          this.initialWorkspaceNavigation(),
        );
      } else {
        navigation = this.navigateWorkspace(this.workspaceUrl, generation);
      }
      return navigation.pipe(
        take(1),
        switchMap((navigated) =>
          navigated
            ? of(ready())
            : this.navigateWorkspace('/', generation).pipe(
                map((fallback) =>
                  fallback
                    ? ready([
                        warning(
                          'workspace-restoration',
                          'workspace',
                          'workspace-safe-root-fallback',
                        ),
                      ])
                    : ({
                        kind: 'blocked',
                        recovery: 'retry-startup',
                        diagnostic: { code: 'workspace-navigation-failed' },
                      } as const),
                ),
              ),
        ),
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

  private navigateWorkspace(
    url: string,
    generation: number,
  ): Observable<boolean> {
    return defer(() =>
      from(this.router.navigateByUrl(url, { replaceUrl: true })),
    ).pipe(
      timeout({
        first: APPLICATION_STARTUP_PRODUCER_POLICIES.workspace.attemptBudgetMs,
        with: () => of(false),
      }),
      map(
        (navigated) =>
          generation === this.workspaceNavigationGeneration && navigated,
      ),
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
