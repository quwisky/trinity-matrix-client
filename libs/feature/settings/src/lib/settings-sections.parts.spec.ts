import {
  signal,
  type EnvironmentProviders,
  type Provider,
  type Type,
} from '@angular/core';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import {
  AppearanceEffects,
  provideAppearancePreferences,
} from '@trinity/application/appearance';
import { WorkspaceApplicationSurfaceService } from '@trinity/application/workspace';
import { AvatarComponent } from '@trinity/components/generic-content';
import { provideTrnIcons } from '@trinity/components/foundations';
import {
  TrnAlertService,
  TrnDialogService,
  TrnSettingsParts,
  TrnToastService,
} from '@trinity/components/overlay';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { AuthService } from '@trinity/data-access/auth';
import {
  AccountIdentitiesService,
  IdentityPresenceService,
  IdentityService,
  type IdentityProfile,
} from '@trinity/data-access/identity';
import { GifSettingsService } from '@trinity/data-access/gif';
import { HomeserverInfoService } from '@trinity/data-access/homeserver';
import { ImagePackManagementService } from '@trinity/data-access/media';
import {
  KeywordRulesService,
  PushGatewayService,
  PushService,
  NotificationSoundService,
  PushRulesService,
  ReactionNotificationSettingsService,
} from '@trinity/data-access/notifications';
import {
  SpaceRoomOrderService,
  TRINITY_ROOM_SORTS,
} from '@trinity/data-access/room-library';
import {
  CONVERSATION_PRIVACY_PREFERENCES,
  UrlPreviewService,
  provideConversationPrivacyPreferences,
} from '@trinity/data-access/timeline';
import { TrustDevicesService, TrustService } from '@trinity/data-access/trust';
import {
  AppConfigService,
  BUILD_INFO,
  ExternalBrowserService,
  FeatureFlagsService,
  SystemLineSettingsService,
  providePrivacyPreferenceSet,
} from '@trinity/platform-native';
import { PREFERENCE_STORAGE_ADAPTER } from '@trinity/runtime/preferences';
import { HostFileExportService } from '@trinity/runtime/host';
import { desktopBridgeFixture, render } from '@trinity/testing';
import { MockComponent, MockProvider } from 'ng-mocks';
import { NEVER, of } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { SETTINGS_SECTIONS } from './settings-sections';

/**
 * Drift guard: the parts a section declares in SETTINGS_SECTIONS (which search and the
 * nav read without rendering anything) must be exactly the groups the section renders.
 *
 * Each section is rendered under the conditions that give its FULL group list: Appearance
 * needs the desktop bridge for its Window group. Groups that stay conditional must be
 * declared anyway and documented in the design spec.
 */

const STORAGE = {
  provide: PREFERENCE_STORAGE_ADAPTER,
  useValue: {
    read: () => of({ kind: 'missing' }),
    write: () => of({ kind: 'completed' }),
  },
};
const FILE_EXPORT = MockProvider(HostFileExportService, {
  support: () => of({ kind: 'supported' } as const),
});

interface Setup {
  readonly providers: readonly (Provider | EnvironmentProviders)[];
  readonly imports?: readonly Type<unknown>[];
}

const SETUPS: Record<string, () => Setup> = {
  profile: () => ({
    imports: [MockComponent(AvatarComponent)],
    providers: [
      MockProvider(IdentityService, {
        profile: signal<IdentityProfile | null>(null).asReadonly(),
        load: () =>
          of({ userId: '@me:hs', displayName: 'Me', avatarMxc: null }),
      }),
    ],
  }),
  presence: () => ({
    providers: [
      MockProvider(IdentityPresenceService, {
        myPresence: signal('online' as const).asReadonly(),
        myStatusMessage: signal('').asReadonly(),
        loadOwnPresence: () => undefined,
      }),
    ],
  }),
  devices: () => ({
    providers: [
      MockProvider(TrustDevicesService, {
        devices: signal([]),
        list: () => of([]),
      }),
      MockProvider(TrnAlertService),
      MockProvider(WorkspaceApplicationSurfaceService),
    ],
  }),
  account: () => ({
    providers: [
      MockProvider(AuthService, { getAccountManagement: () => of(null) }),
      MockProvider(TrnToastService),
      MockProvider(ExternalBrowserService),
    ],
  }),
  security: () => ({
    providers: [
      MockProvider(TrustService, {
        health: signal({
          availability: 'unavailable',
          current: null,
          stale: null,
        } as const).asReadonly(),
        status: signal('unknown' as const).asReadonly(),
        keyBackupActive: signal(null).asReadonly(),
        thisDeviceVerified: signal(null).asReadonly(),
      }),
      MockProvider(WorkspaceApplicationSurfaceService),
      MockProvider(TrnAlertService),
      MockProvider(TrnToastService),
      FILE_EXPORT,
    ],
  }),
  appearance: () => {
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture({
        capabilities: {
          titleBar: {
            getSystemTitleBar: async () => ({ saved: false, active: false }),
            setSystemTitleBar: async () => ({ kind: 'completed' as const }),
            relaunch: () => undefined,
          },
        },
      });
    return {
      providers: [
        provideAppearancePreferences(),
        STORAGE,
        MockProvider(AppearanceEffects, {
          resolved: signal(undefined).asReadonly(),
          run: () => NEVER,
        }),
        MockProvider(SystemLineSettingsService, {
          showMembership: signal(true),
          showProfile: signal(true),
          showRoomChanges: signal(true),
        }),
        MockProvider(SpaceRoomOrderService, {
          modes: TRINITY_ROOM_SORTS,
          defaultMode: signal('recent' as const).asReadonly(),
        }),
      ],
    };
  },
  notifications: () => ({
    providers: [
      MockProvider(PushRulesService, { toggles: [] }),
      MockProvider(NotificationSoundService, {
        enabled: signal(true).asReadonly(),
        connect: () => undefined,
        disconnect: () => undefined,
      }),
      MockProvider(ReactionNotificationSettingsService, {
        enabled: signal(false).asReadonly(),
        connect: () => undefined,
        disconnect: () => undefined,
      }),
      MockProvider(MatrixClientService, {
        activeUserId: signal<string | null>('@me:hs').asReadonly(),
      }),
      MockProvider(KeywordRulesService, {
        keywords: () => [],
        hasLoaded: () => true,
      }),
      MockProvider(TrnToastService),
      MockProvider(PushGatewayService, {
        supported: signal(true).asReadonly(),
        override: signal(null).asReadonly(),
      }),
      MockProvider(PushService, {
        registration: signal({ status: 'idle' as const }).asReadonly(),
      }),
      MockProvider(TrnDialogService),
    ],
  }),
  privacy: () => ({
    providers: [
      provideConversationPrivacyPreferences(),
      providePrivacyPreferenceSet(CONVERSATION_PRIVACY_PREFERENCES),
      STORAGE,
      MockProvider(UrlPreviewService, { supported: signal(null) }),
    ],
  }),
  server: () => ({
    providers: [
      {
        provide: BUILD_INFO,
        useValue: { version: '9.9.9', commit: 'abc1234', builtAt: '' },
      },
      MockProvider(MatrixClientService, {
        accountIds: signal<readonly string[]>(['@me:hs']).asReadonly(),
      }),
      MockProvider(HomeserverInfoService, {
        infos: signal(new Map()).asReadonly(),
        load: () => of(undefined),
      }),
      MockProvider(AccountIdentitiesService, {
        identityOf: (userId: string) => ({
          userId,
          displayName: userId,
          avatarMxc: null,
        }),
      }),
    ],
  }),
  gifs: () => ({
    providers: [
      MockProvider(GifSettingsService, {
        provider: signal('klipy' as const).asReadonly(),
        apiKey: signal('').asReadonly(),
        configured: signal(false).asReadonly(),
        migratedFrom: signal(null).asReadonly(),
      }),
    ],
  }),
  stickers: () => ({
    providers: [
      {
        provide: ImagePackManagementService,
        useValue: {
          installed: signal([]).asReadonly(),
          connect: () => undefined,
          disconnect: () => undefined,
        },
      },
      MockProvider(TrnAlertService),
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
      },
    ],
  }),
  shortcuts: () => ({
    providers: [MockProvider(TrnAlertService), MockProvider(TrnToastService)],
  }),
  experimental: () => ({
    providers: [
      MockProvider(FeatureFlagsService, { virtualTimeline: signal(false) }),
    ],
  }),
  advanced: () => ({
    providers: [
      MockProvider(AppConfigService, { exportJson: () => '{"version":1}' }),
      MockProvider(TrnAlertService),
      MockProvider(TrnToastService),
      FILE_EXPORT,
    ],
  }),
};

/** Sections whose whole page is one untitled group: no parts to list. */
const SINGLE_GROUP = [
  'profile',
  'presence',
  'devices',
  'account',
  'privacy',
  'server',
  'gifs',
  'shortcuts',
  'experimental',
];

describe('SETTINGS_SECTIONS parts', () => {
  afterEach(() => {
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
  });

  it('has a render setup for every section', () => {
    expect(Object.keys(SETUPS).sort()).toEqual(
      SETTINGS_SECTIONS.map((section) => section.path).sort(),
    );
  });

  it('pins which sections declare no parts', () => {
    expect(
      SETTINGS_SECTIONS.filter((section) => section.parts.length === 0)
        .map((section) => section.path)
        .sort(),
    ).toEqual([...SINGLE_GROUP].sort());
  });

  it.each(SETTINGS_SECTIONS.map((section) => [section.path, section] as const))(
    'declares the groups %s renders',
    async (path, section) => {
      const setup = SETUPS[path]();
      const parts = new TrnSettingsParts();
      const { fixture } = await render(section.component, {
        imports: [...(setup.imports ?? [])],
        providers: [
          provideTrnIcons(),
          { provide: TrnSettingsParts, useValue: parts },
          ...setup.providers,
        ],
      });
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      const rendered = parts.parts().map((part) => part.id);
      expect(rendered).toEqual(section.parts.map((part) => part.id));
      // Labels shown in search are the headings people see in the page.
      if (section.parts.length) {
        expect(parts.parts().map((part) => part.label)).toEqual(
          section.parts.map((part) => part.label),
        );
      }
    },
  );
});
