import { Routes } from '@angular/router';
import { SettingsPage } from './settings/settings.page';
import { ProfileSettingsComponent } from './profile/profile-settings.component';
import { AppearanceSettingsComponent } from './appearance/appearance-settings.component';
import { ExperimentalSettingsComponent } from './experimental/experimental-settings.component';
import { DevicesSectionComponent } from './devices/devices-section.component';
import { GifsSectionComponent } from './gifs/gifs-section.component';
import { PresenceSectionComponent } from './presence/presence-section.component';

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
      { path: 'gifs', component: GifsSectionComponent },
      { path: 'experimental', component: ExperimentalSettingsComponent },
    ],
  },
];
