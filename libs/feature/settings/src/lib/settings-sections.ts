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

/** A named group of one section, in page order; it is what search and the nav list. */
export interface SettingsSectionPart {
  readonly id: string;
  readonly label: string;
}

export interface SettingsSectionDefinition {
  readonly path: string;
  readonly label: string;
  readonly icon: TrnIconName;
  readonly group: SettingsSectionGroup;
  readonly component: Type<unknown>;
  /**
   * The groups the section renders, in order. A section whose whole page is one group
   * (untitled; the section name is the page's h1) declares none. Kept equal to what the section renders by
   * `settings-sections.parts.spec.ts`; a part that is only sometimes shown (Window, on
   * desktop) is declared anyway.
   */
  readonly parts: readonly SettingsSectionPart[];
}

/** One search hit: a section, or one part of a section. */
export interface SettingsSearchResult {
  readonly section: SettingsSectionDefinition;
  readonly part?: SettingsSectionPart;
}

/** The one ordered registry consumed by both routed and modal settings shells. */
export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  {
    path: 'profile',
    label: 'Profile',
    icon: 'user',
    group: 'Account',
    component: ProfileSettingsComponent,
    parts: [],
  },
  {
    path: 'presence',
    label: 'Presence',
    icon: 'circle-dot',
    group: 'Account',
    component: PresenceSectionComponent,
    parts: [],
  },
  {
    path: 'devices',
    label: 'Devices',
    icon: 'monitor-smartphone',
    group: 'Account',
    component: DevicesSectionComponent,
    parts: [],
  },
  {
    path: 'account',
    label: 'Account',
    icon: 'key-round',
    group: 'Account',
    component: AccountSectionComponent,
    parts: [],
  },
  {
    path: 'security',
    label: 'Security',
    icon: 'lock',
    group: 'Account',
    component: SecuritySectionComponent,
    parts: [
      { id: 'this-session', label: 'This session' },
      { id: 'key-backup', label: 'Key backup' },
      { id: 'encrypted-key-export', label: 'Encrypted key export' },
    ],
  },
  {
    path: 'appearance',
    label: 'Appearance',
    icon: 'palette',
    group: 'Preferences',
    component: AppearanceSettingsComponent,
    parts: [
      { id: 'mode-and-theme', label: 'Mode and theme' },
      { id: 'layout', label: 'Layout' },
      { id: 'code-blocks', label: 'Code blocks' },
      { id: 'date-and-time', label: 'Date and time' },
      { id: 'room-lists', label: 'Room lists' },
      { id: 'timeline', label: 'Timeline' },
      { id: 'message-gestures', label: 'Message gestures' },
      { id: 'window', label: 'Window' },
    ],
  },
  {
    path: 'notifications',
    label: 'Notifications',
    icon: 'bell',
    group: 'Preferences',
    component: NotificationsSectionComponent,
    parts: [
      { id: 'keywords', label: 'Keywords' },
      { id: 'push-gateway-this-device', label: 'Push gateway (this device)' },
    ],
  },
  {
    path: 'privacy',
    label: 'Privacy',
    icon: 'shield',
    group: 'Preferences',
    component: PrivacySettingsComponent,
    parts: [],
  },
  {
    path: 'server',
    label: 'Server',
    icon: 'server',
    group: 'App',
    component: ServerSectionComponent,
    parts: [],
  },
  {
    path: 'gifs',
    label: 'GIFs',
    icon: 'image',
    group: 'App',
    component: GifsSectionComponent,
    parts: [],
  },
  {
    path: 'stickers',
    label: 'Stickers & emoji',
    icon: 'smile',
    group: 'App',
    component: ImagePacksSectionComponent,
    parts: [{ id: 'install-from-a-room', label: 'Install from a room' }],
  },
  {
    path: 'shortcuts',
    label: 'Keyboard shortcuts',
    icon: 'keyboard',
    group: 'App',
    component: ShortcutsSectionComponent,
    parts: [],
  },
  {
    path: 'experimental',
    label: 'Experimental',
    icon: 'flask-conical',
    group: 'Developer',
    component: ExperimentalSettingsComponent,
    parts: [],
  },
  {
    path: 'advanced',
    label: 'Advanced',
    icon: 'braces',
    group: 'Developer',
    component: AdvancedSettingsComponent,
    parts: [
      {
        id: 'what-this-document-leaves-out',
        label: 'What this document leaves out',
      },
      { id: 'reset-to-defaults', label: 'Reset to defaults' },
    ],
  },
];

/**
 * Search only directory metadata. A section matches by its label or group; a part matches
 * by its title and follows its section's own result.
 */
export function matchingSettingsSections(
  query: string,
): readonly SettingsSearchResult[] {
  const term = query.trim().toLowerCase();
  const results: SettingsSearchResult[] = [];
  for (const section of SETTINGS_SECTIONS) {
    if (
      section.label.toLowerCase().includes(term) ||
      section.group.toLowerCase().includes(term)
    ) {
      results.push({ section });
    }
    for (const part of section.parts) {
      const label = part.label.toLowerCase();
      if (term && label.includes(term)) {
        results.push({ section, part });
      }
    }
  }
  return results;
}

/** The sections a result list touches, once each, in registry order. */
export function sectionsOfResults(
  results: readonly SettingsSearchResult[],
): readonly SettingsSectionDefinition[] {
  return [...new Set(results.map(({ section }) => section))];
}
