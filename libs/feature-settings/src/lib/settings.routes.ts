import { Routes } from '@angular/router';
import { SettingsPage } from './settings/settings.page';
import { ProfileSettingsComponent } from './profile/profile-settings.component';
import { AppearanceSettingsComponent } from './appearance/appearance-settings.component';
import { ExperimentalSettingsComponent } from './experimental/experimental-settings.component';
import { DevicesSectionComponent } from './devices/devices-section.component';
import { GifsSectionComponent } from './gifs/gifs-section.component';
import { PresenceSectionComponent } from './presence/presence-section.component';
import { AccountSectionComponent } from './account/account-section.component';
import { PrivacySettingsComponent } from './privacy/privacy-settings.component';
import { NotificationsSectionComponent } from './notifications/notifications-section.component';

/**
 * Settings routes: the {@link SettingsPage} shell hosts a submenu + a routed detail
 * outlet, one child route per section. Consumed lazily by the app's `/settings` route.
 */
export const settingsRoutes: Routes = [
  {
    path: '',
    component: SettingsPage,
    children: [
      { path: 'profile', component: ProfileSettingsComponent },
      { path: 'presence', component: PresenceSectionComponent },
      { path: 'appearance', component: AppearanceSettingsComponent },
      { path: 'devices', component: DevicesSectionComponent },
      { path: 'account', component: AccountSectionComponent },
      { path: 'notifications', component: NotificationsSectionComponent },
      { path: 'privacy', component: PrivacySettingsComponent },
      { path: 'gifs', component: GifsSectionComponent },
      { path: 'experimental', component: ExperimentalSettingsComponent },
    ],
  },
];
