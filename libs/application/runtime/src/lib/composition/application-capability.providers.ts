import {
  type EnvironmentProviders,
  inject,
  type Provider,
} from '@angular/core';
import {
  APPEARANCE_NATIVE_CHROME_ADAPTER,
  AppearanceEffects,
  AppearancePreferences,
  provideAppearanceConfigEntries,
  provideAppearancePreferences,
} from '@trinity/application/appearance';
import { BADGE_SINK, type BadgeSink } from '@trinity/application/badge';
import { AVATAR_RESOLVER } from '@trinity/components/generic-content';
import {
  ACCOUNT_LIFECYCLE_PORT,
  UNPROTECTED_STORAGE_CONSENT,
  type AccountLifecyclePort,
} from '@trinity/data-access/accounts';
import { AppLockService } from '@trinity/data-access/app-lock';
import {
  AUTHENTICATION_HOMESERVER_DISCOVERY,
  AuthService,
  NEW_DEVICE_SIGN_IN,
  OidcClientService,
  QR_LINK_IDENTITY_CHECK,
  QR_SIGN_IN_COMPLETION,
  type AuthenticationHomeserverDiscovery,
} from '@trinity/data-access/auth';
import { DiagnosticLogService } from '@trinity/data-access/diagnostic-log';
import { HomeserverDiscoveryService } from '@trinity/data-access/discovery';
import { provideGifConfigEntries } from '@trinity/data-access/gif';
import { AvatarService, MediaService } from '@trinity/data-access/media';
import {
  NOTIFICATION_VISIBILITY,
  PUSH_CONFIG,
  PushHandoffService,
  PushService,
  type NotificationVisibilityPort,
  type PushConfig,
  provideMentionInboxPreferences,
} from '@trinity/data-access/notifications';
import {
  RoomActionPermissionsService,
  RoomMessageGovernanceService,
  RoomPinGovernanceService,
} from '@trinity/data-access/room-administration';
import {
  ROOM_LIBRARY_GOVERNANCE_POLICY,
  ROOM_LIST_STYLE,
  type RoomLibraryGovernancePolicy,
  provideRoomLibraryConfigEntries,
  provideRoomLibraryPreferences,
} from '@trinity/data-access/room-library';
import {
  CONVERSATION_MESSAGE_POLICY,
  CONVERSATION_PIN_POLICY,
  CONVERSATION_PRIVACY_PREFERENCES,
  ConversationRuntime,
  type ConversationMessagePolicy,
  type ConversationPinPolicy,
  provideConversationPrivacyPreferences,
} from '@trinity/data-access/timeline';
import {
  TRUST_ACCOUNT_PREFERENCES,
  TRUST_PROVIDER_RECOVERY,
  TrustDevicesService,
  type TrustProviderRecoveryPort,
} from '@trinity/data-access/trust';
import {
  WIDGET_APPEARANCE_PROJECTION,
  type WidgetAppearanceProjection,
} from '@trinity/data-access/widgets';
import {
  RELEASE_NOTES,
  type ReleaseNote,
} from '@trinity/data-access/whats-new';
import {
  BUILD_INFO,
  DraftStoreService,
  NativeAppearanceChromeAdapter,
  NativeTokenBridge,
  type BuildInfo,
  providePlatformConfigEntries,
  providePrivacyPreferenceSet,
} from '@trinity/platform-native';
import { HostBadgeService } from '@trinity/runtime/host';
import { PreferenceStoreService } from '@trinity/runtime/preferences';
import { map, of, switchMap, tap } from 'rxjs';
import { appLockCovers, visibilityWhileLocked } from './app-lock.providers';
import { NewDeviceSignInPresenter } from './new-device-sign-in.presenter';
import { UnprotectedStorageConsentPresenter } from './unprotected-storage.presenter';

interface ApplicationCapabilityProviderOptions {
  readonly buildInfo: BuildInfo;
  readonly releaseNotes: readonly ReleaseNote[];
  readonly pushConfig: PushConfig | null;
}

/** Internal cross-capability bindings hidden behind the application provider interface. */
export function applicationCapabilityProviders(
  options: ApplicationCapabilityProviderOptions,
): readonly (Provider | EnvironmentProviders)[] {
  return [
    provideAppearancePreferences(),
    provideAppearanceConfigEntries(),
    provideConversationPrivacyPreferences(),
    provideRoomLibraryPreferences(),
    provideMentionInboxPreferences(),
    providePrivacyPreferenceSet(CONVERSATION_PRIVACY_PREFERENCES),
    {
      provide: APPEARANCE_NATIVE_CHROME_ADAPTER,
      useExisting: NativeAppearanceChromeAdapter,
    },
    {
      provide: ROOM_LIST_STYLE,
      useFactory: () => inject(AppearancePreferences).axes.roomList.value,
    },
    {
      provide: WIDGET_APPEARANCE_PROJECTION,
      useFactory: (): WidgetAppearanceProjection => ({
        resolved: inject(AppearanceEffects).resolved,
      }),
    },
    {
      provide: AUTHENTICATION_HOMESERVER_DISCOVERY,
      useFactory: (): AuthenticationHomeserverDiscovery => {
        const discovery = inject(HomeserverDiscoveryService);
        return {
          discover: (input) => discovery.discover(input),
          lookUp: (input) => discovery.discover(input, { allowOrigins: false }),
        };
      },
    },
    {
      provide: ROOM_LIBRARY_GOVERNANCE_POLICY,
      useFactory: (): RoomLibraryGovernancePolicy => {
        const permissions = inject(RoomActionPermissionsService);
        return {
          authorize: (key, action) => {
            const availability =
              action === 'invite'
                ? permissions.roomFor(key).invite
                : permissions.roomFor(key).curateSpace;
            return availability.available
              ? { kind: 'allowed' }
              : {
                  kind: 'rejected',
                  reason:
                    availability.reason ?? 'This room action is unavailable.',
                };
          },
        };
      },
    },
    {
      provide: BADGE_SINK,
      useFactory: (): BadgeSink => {
        const host = inject(HostBadgeService);
        return { write: (count) => host.set(count) };
      },
    },
    {
      provide: CONVERSATION_MESSAGE_POLICY,
      useFactory: (): ConversationMessagePolicy => {
        const governance = inject(RoomMessageGovernanceService);
        return {
          canRedactOthers: (key) => governance.canRedactOthers(key),
          canSendMessages: (key) => governance.canSendMessages(key),
          authorizeRedaction: ({ key, messageId }) =>
            governance.authorizeRedaction({ ...key, messageId }),
        };
      },
    },
    {
      provide: CONVERSATION_PIN_POLICY,
      useFactory: (): ConversationPinPolicy => {
        const governance = inject(RoomPinGovernanceService);
        return {
          canMutate: (key) => governance.canMutate(key),
          authorize: (key, operation, eventId) =>
            governance.authorize(key, operation, eventId),
        };
      },
    },
    {
      provide: NOTIFICATION_VISIBILITY,
      useFactory: (): NotificationVisibilityPort => {
        const conversations = inject(ConversationRuntime);
        const appLock = inject(AppLockService);
        return {
          // The lock cover keeps the window focused, but nobody is looking behind it.
          snapshot: () =>
            visibilityWhileLocked(
              {
                foreground: document.hasFocus(),
                hidden: document.visibilityState === 'hidden',
                conversation: conversations.focused()?.key ?? null,
              },
              appLockCovers(appLock.status()),
            ),
        };
      },
    },
    {
      provide: ACCOUNT_LIFECYCLE_PORT,
      useFactory: (): AccountLifecyclePort => {
        const avatars = inject(AvatarService);
        const media = inject(MediaService);
        const push = inject(PushService);
        const handoff = inject(PushHandoffService);
        const drafts = inject(DraftStoreService);
        const oidc = inject(OidcClientService);
        const nativeTokens = inject(NativeTokenBridge);
        const diagnosticLog = inject(DiagnosticLogService);
        const preferences = inject(PreferenceStoreService);
        return {
          forgetPushHandoff: (accountId) => handoff.forget(accountId),
          registerNotifications: () => push.register(),
          unregisterNotifications: (accountId) => push.unregister(accountId),
          revokeProviderSession: (session) => {
            const { oidc: binding } = session;
            return binding
              ? nativeTokens.revokeStored(session).pipe(
                  // A live client's logout(true) runs alongside this in a reset: a harmless repeat.
                  switchMap((answer) =>
                    answer === 'revoked'
                      ? of(void 0)
                      : oidc
                          .revokeTokens(session.baseUrl, binding, {
                            accessToken: session.accessToken,
                            refreshToken: session.refreshToken,
                          })
                          .pipe(
                            tap(() => {
                              // Native may still hold a refresh token this can't reach.
                              if (answer === 'transient') {
                                throw new Error(
                                  'The native token revocation did not finish.',
                                );
                              }
                            }),
                          ),
                  ),
                )
              : of(void 0);
          },
          stopDiagnosticLog: () => diagnosticLog.discard(),
          resumeDiagnosticLog: () => diagnosticLog.resumeAfterReset(),
          releaseSharedCaches: () => {
            avatars.releaseAll();
            media.releaseAll();
          },
          clearDrafts: () => drafts.clearAll(),
          forgetAccountPreferences: (accountId) =>
            preferences
              .forgetAccount(accountId, TRUST_ACCOUNT_PREFERENCES)
              .pipe(
                map((outcome) => {
                  if (outcome.kind !== 'completed') {
                    throw new Error('Account preferences were not removed.');
                  }
                }),
              ),
        };
      },
    },
    { provide: NEW_DEVICE_SIGN_IN, useExisting: NewDeviceSignInPresenter },
    { provide: QR_SIGN_IN_COMPLETION, useExisting: AuthService },
    { provide: QR_LINK_IDENTITY_CHECK, useExisting: TrustDevicesService },
    {
      provide: UNPROTECTED_STORAGE_CONSENT,
      useExisting: UnprotectedStorageConsentPresenter,
    },
    {
      provide: TRUST_PROVIDER_RECOVERY,
      useFactory: (): TrustProviderRecoveryPort => {
        const auth = inject(AuthService);
        return { accountManagement: () => auth.getAccountManagement() };
      },
    },
    {
      provide: AVATAR_RESOLVER,
      useFactory: () => {
        const avatars = inject(AvatarService);
        return (mxc: string | null, size: number, accountId?: string) =>
          avatars.resolve(mxc, size, accountId);
      },
    },
    providePlatformConfigEntries(),
    provideGifConfigEntries(),
    provideRoomLibraryConfigEntries(),
    { provide: PUSH_CONFIG, useValue: options.pushConfig },
    { provide: BUILD_INFO, useValue: options.buildInfo },
    { provide: RELEASE_NOTES, useValue: options.releaseNotes },
  ];
}
