import { Routes } from '@angular/router';
import { SettingsPage } from './settings/settings.page';
import { ProfileSettingsComponent } from './profile/profile-settings.component';
import { AppearanceSettingsComponent } from './appearance/appearance-settings.component';
import { ExperimentalSettingsComponent } from './experimental/experimental-settings.component';
import { AdvancedSettingsComponent } from './advanced/advanced-settings.component';
import { provideConfigEditor } from './advanced/config-editor-loader';
import { DevicesSectionComponent } from './devices/devices-section.component';
import { GifsSectionComponent } from './gifs/gifs-section.component';
import { PresenceSectionComponent } from './presence/presence-section.component';
import { AccountSectionComponent } from './account/account-section.component';
import { PrivacySettingsComponent } from './privacy/privacy-settings.component';
import { NotificationsSectionComponent } from './notifications/notifications-section.component';
import { SecuritySectionComponent } from './security/security-section.component';
import { ShortcutsSectionComponent } from './shortcuts/shortcuts-section.component';

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
      { path: 'security', component: SecuritySectionComponent },
      { path: 'notifications', component: NotificationsSectionComponent },
      { path: 'privacy', component: PrivacySettingsComponent },
      { path: 'gifs', component: GifsSectionComponent },
      { path: 'shortcuts', component: ShortcutsSectionComponent },
      { path: 'experimental', component: ExperimentalSettingsComponent },
      {
        path: 'advanced',
        component: AdvancedSettingsComponent,
        // The rich editor is offered by the route rather than reached from the component, so
        // the one dynamic import that pulls CodeMirror in is wired where the platform question
        // is answered — and a section rendered without this route (a spec) still edits, in its
        // textarea, without ever touching that chunk.
        providers: [provideConfigEditor()],
      },
    ],
  },
];
