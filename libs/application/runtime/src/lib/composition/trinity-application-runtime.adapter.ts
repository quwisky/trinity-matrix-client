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
  catchError,
  defer,
  filter,
  forkJoin,
  from,
  ignoreElements,
  map,
  of,
  take,
} from 'rxjs';
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
  private manifest: HostCapabilityManifest | null = null;
  private accountRecoveryId: string | null = null;
  private workspaceNavigationStarted = false;
  private workspaceUrl: string | null = null;

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
        this.accountRecoveryId =
          result.kind === 'active-account-unavailable'
            ? result.activeAccountId
            : null;
        switch (result.kind) {
          case 'no-accounts':
          case 'restored':
            return ready();
          case 'restored-with-inactive-failures':
            return ready([
              warning(
                'account-restoration',
                'accounts',
                'inactive-account-restore-failed',
              ),
            ]);
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
      return forkJoin({
        ordering: this.spaceOrder.hydrateKnownAccounts().pipe(map(() => null)),
        persistence: this.storagePersistence
          .requestPersistence()
          .pipe(map(() => null)),
      }).pipe(
        map(() => ready(badgeWarning)),
        catchError(() =>
          of({
            kind: 'blocked',
            recovery: 'retry-startup',
            diagnostic: { code: 'session-capability-establishment-failed' },
          } as const),
        ),
      );
    });
  }

  restoreWorkspace(): Observable<ApplicationStartupStageOutcome> {
    return new Observable((subscriber) => {
      const settled = this.router.events
        .pipe(
          filter(
            (event) =>
              event instanceof NavigationEnd ||
              event instanceof NavigationError ||
              event instanceof NavigationSkipped,
          ),
          take(1),
          map((event) =>
            event instanceof NavigationEnd || event instanceof NavigationSkipped
              ? ready()
              : ({
                  kind: 'blocked',
                  recovery: 'retry-startup',
                  diagnostic: { code: 'workspace-navigation-failed' },
                } as const),
          ),
        )
        .subscribe(subscriber);
      this.workspaceUrl = this.location.path(true) || this.workspaceUrl || '/';
      let navigation: { unsubscribe(): void } | null = null;
      if (!this.workspaceNavigationStarted) {
        this.workspaceNavigationStarted = true;
        this.router.initialNavigation();
      } else {
        navigation = from(
          this.router.navigateByUrl(this.workspaceUrl, { replaceUrl: true }),
        )
          .pipe(catchError(() => of(false)))
          .subscribe((navigated) => {
            if (!navigated && !subscriber.closed) {
              subscriber.next({
                kind: 'blocked',
                recovery: 'retry-startup',
                diagnostic: { code: 'workspace-navigation-failed' },
              });
              subscriber.complete();
            }
          });
      }
      return () => {
        settled.unsubscribe();
        navigation?.unsubscribe();
      };
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
}
