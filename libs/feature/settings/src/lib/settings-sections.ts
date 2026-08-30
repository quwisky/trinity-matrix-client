import type { Type } from '@angular/core';
import type { TrnIconName } from '@trinity/components/foundations';
import { AccountSectionComponent } from './account/account-section.component';
import { AdvancedSettingsComponent } from './advanced/advanced-settings.component';
import { AppearanceSettingsComponent } from './appearance/appearance-settings.component';
import { DevicesSectionComponent } from './devices/devices-section.component';
import { ExperimentalSettingsComponent } from './experimental/experimental-settings.component';
import { GifsSectionComponent } from './gifs/gifs-section.component';
import { ImagePacksSectionComponent } from './image-packs/image-packs-section.component';
import { NotificationsSectionComponent } from './notifications/notifications-section.component';
import { PresenceSectionComponent } from './presence/presence-section.component';
import { PrivacySettingsComponent } from './privacy/privacy-settings.component';
import { ProfileSettingsComponent } from './profile/profile-settings.component';
import { SecuritySectionComponent } from './security/security-section.component';
import { ServerSectionComponent } from './server/server-section.component';
import { ShortcutsSectionComponent } from './shortcuts/shortcuts-section.component';

export type SettingsSectionGroup =
  'Account' | 'Preferences' | 'App' | 'Developer';

export interface SettingsSectionDefinition {
  readonly path: string;
  readonly label: string;
  readonly icon: TrnIconName;
  readonly group: SettingsSectionGroup;
  readonly component: Type<unknown>;
}

/** The one ordered registry consumed by both routed and modal settings shells. */
export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  {
    path: 'profile',
    label: 'Profile',
    icon: 'user',
    group: 'Account',
    component: ProfileSettingsComponent,
  },
  {
    path: 'presence',
    label: 'Presence',
    icon: 'circle-dot',
    group: 'Account',
    component: PresenceSectionComponent,
  },
  {
    path: 'devices',
    label: 'Devices',
    icon: 'monitor-smartphone',
    group: 'Account',
    component: DevicesSectionComponent,
  },
  {
    path: 'account',
    label: 'Account',
    icon: 'key-round',
    group: 'Account',
    component: AccountSectionComponent,
  },
  {
    path: 'security',
    label: 'Security',
    icon: 'lock',
    group: 'Account',
    component: SecuritySectionComponent,
  },
  {
    path: 'appearance',
    label: 'Appearance',
    icon: 'palette',
    group: 'Preferences',
    component: AppearanceSettingsComponent,
  },
  {
    path: 'notifications',
    label: 'Notifications',
    icon: 'bell',
    group: 'Preferences',
    component: NotificationsSectionComponent,
  },
  {
    path: 'privacy',
    label: 'Privacy',
    icon: 'shield',
    group: 'Preferences',
    component: PrivacySettingsComponent,
  },
  {
    path: 'server',
    label: 'Server',
    icon: 'server',
    group: 'App',
    component: ServerSectionComponent,
  },
  {
    path: 'gifs',
    label: 'GIFs',
    icon: 'image',
    group: 'App',
    component: GifsSectionComponent,
  },
  {
    path: 'stickers',
    label: 'Stickers & emoji',
    icon: 'smile',
    group: 'App',
    component: ImagePacksSectionComponent,
  },
  {
    path: 'shortcuts',
    label: 'Keyboard shortcuts',
    icon: 'keyboard',
    group: 'App',
    component: ShortcutsSectionComponent,
  },
  {
    path: 'experimental',
    label: 'Experimental',
    icon: 'flask-conical',
    group: 'Developer',
    component: ExperimentalSettingsComponent,
  },
  {
    path: 'advanced',
    label: 'Advanced',
    icon: 'braces',
    group: 'Developer',
    component: AdvancedSettingsComponent,
  },
];
