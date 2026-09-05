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
  ApplicationStartupRecovery,
  ApplicationStartupStageOutcome,
} from '../application-runtime.models';
import { APPLICATION_STARTUP_PRODUCER_POLICIES } from '../application-startup.policy';
import {
  AppearanceEffects,
  AppearancePreferences,
} from '@trinity/application/appearance';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { GifSettingsService } from '@trinity/data-access/gif';
import { PushGatewayService } from '@trinity/data-access/notifications';
import {
  AccountScopeService,
  SpaceRoomOrderService,
} from '@trinity/data-access/room-library';
import {
  AppConfigService,
  ComposerSettingsService,
  DateTimeFormatService,
  DraftStoreService,
  FeatureFlagsService,
  KeyboardShortcutsService,
  MessageGestureSettingsService,
  PrivacySettingsService,
  ShellLayoutService,
  StoragePersistenceService,
  SystemLineSettingsService,
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
  ignoreElements,
  map,
  of,
  switchMap,
  take,
  timeout,
} from 'rxjs';
import { AccountStartupHealthService } from './account-startup-health.service';
import { TrinityApplicationSessionAdapter } from './trinity-application-session.adapter';

const ready = (
  warnings: readonly ApplicationRuntimeWarning[] = [],
): ApplicationStartupStageOutcome => ({
  kind: 'ready',
  ...(warnings.length > 0 ? { warnings } : {}),
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
  private readonly appearance = inject(AppearancePreferences);
  private readonly appearanceEffects = inject(AppearanceEffects);
  private readonly shellLayout = inject(ShellLayoutService);
  private readonly featureFlags = inject(FeatureFlagsService);
  private readonly privacy = inject(PrivacySettingsService);
  private readonly drafts = inject(DraftStoreService);
  private readonly systemLines = inject(SystemLineSettingsService);
  private readonly composer = inject(ComposerSettingsService);
  private readonly gestures = inject(MessageGestureSettingsService);
  private readonly dateTime = inject(DateTimeFormatService);
  private readonly shortcuts = inject(KeyboardShortcutsService);
  private readonly gifs = inject(GifSettingsService);
  private readonly accountScope = inject(AccountScopeService);
  private readonly appConfig = inject(AppConfigService);
  private readonly pushGateway = inject(PushGatewayService);
  private readonly spaceOrder = inject(SpaceRoomOrderService);
  private readonly storagePersistence = inject(StoragePersistenceService);
  private readonly accountHealth = inject(AccountStartupHealthService);
  private manifest: HostCapabilityManifest | null = null;
  private accountRecoveryId: string | null = null;
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
    return defer(() =>
      forkJoin({
        appearance: this.appearance.hydrate(),
        shellLayout: from(this.shellLayout.init()),
        featureFlags: from(this.featureFlags.init()),
        privacy: this.privacy.init(),
        drafts: from(this.drafts.init()),
        systemLines: from(this.systemLines.init()),
        composer: from(this.composer.init()),
        gestures: from(this.gestures.init()),
        dateTime: from(this.dateTime.init()),
        shortcuts: from(this.shortcuts.init()),
        gifs: from(this.gifs.init()),
        accountScope: this.accountScope.init(),
        pushGateway: from(this.pushGateway.init()),
      }),
    ).pipe(
      map(({ appearance, privacy }) => {
        const warnings: ApplicationRuntimeWarning[] = [];
        if (appearance.kind === 'partial') {
          warnings.push({
            stage: 'preference-hydration',
            scope: 'preferences',
            diagnostic: { code: appearance.warning.code },
            recovery: appearance.warning.recovery,
          });
        }
        if (privacy.kind === 'partial') {
          warnings.push({
            stage: 'preference-hydration',
            scope: 'preferences',
            diagnostic: { code: 'preference-hydration-partial' },
            recovery: 'reset-preferences',
          });
        }
        return ready(warnings);
      }),
      catchError(() =>
        of({
          kind: 'blocked',
          recovery: 'reset-preferences',
          diagnostic: { code: 'preference-hydration-failed' },
        } as const),
      ),
    );
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
      const badgeWarning =
        badgeSupport?.kind === 'unavailable' &&
        badgeSupport.reason !== 'not-supported' &&
        badgeSupport.reason !== 'not-implemented'
          ? [warning('session-capabilities', 'badge', 'badge-unavailable')]
          : [];
      const ordering = APPLICATION_STARTUP_PRODUCER_POLICIES['room-order'];
      const persistence =
        APPLICATION_STARTUP_PRODUCER_POLICIES['browser-storage-persistence'];
      return forkJoin({
        ordering: defer(() => this.spaceOrder.hydrateKnownAccounts()).pipe(
          timeout({ first: ordering.budgetMs }),
          map(() => [] as readonly ApplicationRuntimeWarning[]),
          defaultIfEmpty([
            warning(
              'session-capabilities',
              'workspace',
              'room-order-hydration-failed',
            ),
          ]),
          catchError((error: unknown) =>
            of([
              warning(
                'session-capabilities',
                'workspace',
                error instanceof TimeoutError
                  ? ordering.timeoutCode
                  : 'room-order-hydration-failed',
              ),
            ]),
          ),
        ),
        persistence: defer(() =>
          this.storagePersistence.requestPersistence(),
        ).pipe(
          timeout({ first: persistence.budgetMs }),
          map((persisted) =>
            persisted
              ? ([] as readonly ApplicationRuntimeWarning[])
              : [
                  warning(
                    'session-capabilities',
                    'storage',
                    'storage-persistence-denied',
                  ),
                ],
          ),
          defaultIfEmpty([
            warning(
              'session-capabilities',
              'storage',
              'storage-persistence-unavailable',
            ),
          ]),
          catchError((error: unknown) =>
            of([
              warning(
                'session-capabilities',
                'storage',
                error instanceof TimeoutError
                  ? persistence.timeoutCode
                  : 'storage-persistence-unavailable',
              ),
            ]),
          ),
        ),
      }).pipe(
        map(({ ordering, persistence }) =>
          ready([...badgeWarning, ...ordering, ...persistence]),
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
        return this.appConfig.resetToDefaults().pipe(
          map(() => ({ kind: 'ready' }) as const),
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
              if (
                outcome.kind === 'ready' ||
                outcome.kind === 'partial-cleanup'
              ) {
                this.accountRecoveryId = null;
                return { kind: 'ready' };
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

  runPreferenceLifetime(): Observable<ApplicationRuntimeWarning> {
    return this.appearanceEffects.run().pipe(ignoreElements());
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
