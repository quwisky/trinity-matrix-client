import { Injectable, inject } from '@angular/core';
import { AppearancePreferences } from '@trinity/application/appearance';
import { GifSettingsService } from '@trinity/data-access/gif';
import { PushGatewayService } from '@trinity/data-access/notifications';
import { AccountScopeService } from '@trinity/data-access/room-library';
import {
  ComposerSettingsService,
  DateTimeFormatService,
  FeatureFlagsService,
  KeyboardShortcutsService,
  MessageGestureSettingsService,
  PrivacySettingsService,
  ShellLayoutService,
  SystemLineSettingsService,
  type PreferenceInitializationOutcome,
} from '@trinity/platform-native';
import { Observable, defer, map } from 'rxjs';
import type {
  PreferencePreparationEvidence,
  PreferenceStartupProducer,
  PreferenceStartupSources,
} from './preference-startup.policy';
import { PREFERENCE_STARTUP_PRODUCER_POLICIES } from './preference-startup.policy';

/** Concrete Application composition for every registered preference startup producer. */
@Injectable({ providedIn: 'root' })
export class TrinityPreferenceStartupSources {
  private readonly appearance = inject(AppearancePreferences);
  private readonly shellLayout = inject(ShellLayoutService);
  private readonly featureFlags = inject(FeatureFlagsService);
  private readonly privacy = inject(PrivacySettingsService);
  private readonly systemLines = inject(SystemLineSettingsService);
  private readonly composer = inject(ComposerSettingsService);
  private readonly gestures = inject(MessageGestureSettingsService);
  private readonly dateTime = inject(DateTimeFormatService);
  private readonly shortcuts = inject(KeyboardShortcutsService);
  private readonly gifs = inject(GifSettingsService);
  private readonly accountScope = inject(AccountScopeService);
  private readonly pushGateway = inject(PushGatewayService);

  sources(): PreferenceStartupSources {
    const initialized = (
      producer: PreferenceStartupProducer,
      operation: () =>
        | Promise<PreferenceInitializationOutcome>
        | Observable<PreferenceInitializationOutcome>,
    ): Observable<PreferencePreparationEvidence> =>
      defer(operation).pipe(
        map((outcome) =>
          outcome.kind === 'ready'
            ? ({ kind: 'ready' } as const)
            : ({
                kind: 'defaulted',
                code:
                  outcome.reason === 'storage-unavailable'
                    ? PREFERENCE_STARTUP_PRODUCER_POLICIES[producer].defaultCode
                    : PREFERENCE_STARTUP_PRODUCER_POLICIES[producer]
                        .invalidCode,
              } as const),
        ),
      );
    return {
      appearance: () =>
        this.appearance.hydrate().pipe(
          map((outcome): PreferencePreparationEvidence =>
            outcome.kind === 'ready'
              ? { kind: 'ready' }
              : {
                  kind: 'defaulted',
                  code: outcome.warning.code,
                  recover: () =>
                    this.appearance.recoverHydration(outcome.failures).pipe(
                      map((recovered): PreferencePreparationEvidence =>
                        recovered.kind === 'ready'
                          ? { kind: 'ready' }
                          : {
                              kind: 'defaulted',
                              code: recovered.warning.code,
                            },
                      ),
                    ),
                },
          ),
        ),
      'shell-layout': () =>
        initialized('shell-layout', () => this.shellLayout.init()),
      'feature-flags': () =>
        initialized('feature-flags', () => this.featureFlags.init()),
      privacy: () =>
        this.privacy.init().pipe(
          map((outcome): PreferencePreparationEvidence =>
            outcome.kind === 'ready'
              ? { kind: 'ready' }
              : {
                  kind: 'defaulted',
                  code: 'privacy-preference-hydration-partial',
                  recover: () =>
                    this.privacy.recoverHydration(outcome.failures).pipe(
                      map((recovered): PreferencePreparationEvidence =>
                        recovered.kind === 'ready'
                          ? { kind: 'ready' }
                          : {
                              kind: 'defaulted',
                              code: 'privacy-preference-hydration-partial',
                            },
                      ),
                    ),
                },
          ),
        ),
      'system-lines': () =>
        initialized('system-lines', () => this.systemLines.init()),
      composer: () => initialized('composer', () => this.composer.init()),
      gestures: () => initialized('gestures', () => this.gestures.init()),
      'date-time': () => initialized('date-time', () => this.dateTime.init()),
      shortcuts: () => initialized('shortcuts', () => this.shortcuts.init()),
      gifs: () => initialized('gifs', () => this.gifs.init()),
      'account-scope': () =>
        this.accountScope.init().pipe(
          map((outcome): PreferencePreparationEvidence =>
            outcome.kind === 'ready'
              ? { kind: 'ready' }
              : {
                  kind: 'defaulted',
                  code: 'account-scope-preference-hydration-partial',
                  recover: () =>
                    this.accountScope.recoverHydration(outcome.failures).pipe(
                      map((recovered): PreferencePreparationEvidence =>
                        recovered.kind === 'ready'
                          ? { kind: 'ready' }
                          : {
                              kind: 'defaulted',
                              code: 'account-scope-preference-hydration-partial',
                            },
                      ),
                    ),
                },
          ),
        ),
      'push-gateway': () =>
        initialized('push-gateway', () => this.pushGateway.init()).pipe(
          map((evidence): PreferencePreparationEvidence =>
            this.pushGateway.supported()
              ? evidence
              : {
                  kind: 'not-applicable',
                  code: 'push-gateway-platform-unavailable',
                },
          ),
        ),
    };
  }
}
