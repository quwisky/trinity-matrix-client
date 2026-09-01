import {
  type EnvironmentProviders,
  inject,
  type Provider,
} from '@angular/core';
import {
  APPEARANCE_NATIVE_CHROME_ADAPTER,
  AppearanceEffects,
  provideAppearanceConfigEntries,
  provideAppearancePreferences,
} from '@trinity/application/appearance';
import { BADGE_SINK, type BadgeSink } from '@trinity/application/badge';
import { AVATAR_RESOLVER } from '@trinity/components/generic-content';
import {
  ACCOUNT_LIFECYCLE_PORT,
  type AccountLifecyclePort,
} from '@trinity/data-access/accounts';
import {
  AUTHENTICATION_HOMESERVER_DISCOVERY,
  AuthService,
  OidcClientService,
  type AuthenticationHomeserverDiscovery,
} from '@trinity/data-access/auth';
import { HomeserverDiscoveryService } from '@trinity/data-access/discovery';
import { provideGifConfigEntries } from '@trinity/data-access/gif';
import { AvatarService, MediaService } from '@trinity/data-access/media';
import {
  NOTIFICATION_VISIBILITY,
  PUSH_CONFIG,
  PushService,
  type NotificationVisibilityPort,
  type PushConfig,
  providePushConfigEntries,
} from '@trinity/data-access/notifications';
import {
  RoomActionPermissionsService,
  RoomMessageGovernanceService,
  RoomPinGovernanceService,
} from '@trinity/data-access/room-administration';
import {
  ROOM_LIBRARY_GOVERNANCE_POLICY,
  type RoomLibraryGovernancePolicy,
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
  TRUST_PROVIDER_RECOVERY,
  type TrustProviderRecoveryPort,
} from '@trinity/data-access/trust';
import {
  WIDGET_APPEARANCE_PROJECTION,
  type WidgetAppearanceProjection,
} from '@trinity/data-access/widgets';
import {
  BUILD_INFO,
  DraftStoreService,
  NativeAppearanceChromeAdapter,
  type BuildInfo,
  providePlatformConfigEntries,
  providePrivacyPreferenceSet,
} from '@trinity/platform-native';
import { HostBadgeService } from '@trinity/runtime/host';
import { of } from 'rxjs';

interface ApplicationCapabilityProviderOptions {
  readonly buildInfo: BuildInfo;
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
    providePrivacyPreferenceSet(CONVERSATION_PRIVACY_PREFERENCES),
    {
      provide: APPEARANCE_NATIVE_CHROME_ADAPTER,
      useExisting: NativeAppearanceChromeAdapter,
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
        return { discover: (input) => discovery.discover(input) };
      },
    },
    {
      provide: ROOM_LIBRARY_GOVERNANCE_POLICY,
      useFactory: (): RoomLibraryGovernancePolicy => {
        const permissions = inject(RoomActionPermissionsService);
        return {
          authorize: (roomId, action) => {
            const availability =
              action === 'invite'
                ? permissions.room(roomId).invite
                : permissions.room(roomId).curateSpace;
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
        return {
          snapshot: () => ({
            foreground: document.hasFocus(),
            conversation: conversations.focused()?.key ?? null,
          }),
        };
      },
    },
    {
      provide: ACCOUNT_LIFECYCLE_PORT,
      useFactory: (): AccountLifecyclePort => {
        const avatars = inject(AvatarService);
        const media = inject(MediaService);
        const push = inject(PushService);
        const drafts = inject(DraftStoreService);
        const oidc = inject(OidcClientService);
        return {
          registerNotifications: () => push.register(),
          unregisterNotifications: (accountId) => push.unregister(accountId),
          revokeProviderSession: (session) =>
            session.oidc
              ? oidc.revokeTokens(session.baseUrl, session.oidc, {
                  accessToken: session.accessToken,
                  refreshToken: session.refreshToken,
                })
              : of(void 0),
          releaseSharedCaches: () => {
            avatars.releaseAll();
            media.releaseAll();
          },
          clearDrafts: () => drafts.clearAll(),
        };
      },
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
    providePushConfigEntries(),
    { provide: PUSH_CONFIG, useValue: options.pushConfig },
    { provide: BUILD_INFO, useValue: options.buildInfo },
  ];
}
