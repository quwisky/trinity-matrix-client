import { Routes } from '@angular/router';
import { SettingsPage } from './settings/settings.page';
import { provideConfigEditor } from './advanced/config-editor-loader';
import { SETTINGS_SECTIONS } from './settings-sections';

/**
 * Settings routes: the {@link SettingsPage} shell hosts a submenu + a routed detail
 * outlet, one child route per section. Consumed lazily by the app's `/settings` route.
 */
export const settingsRoutes: Routes = [
  {
    path: '',
    component: SettingsPage,
    children: SETTINGS_SECTIONS.map((section) => ({
      path: section.path,
      component: section.component,
      ...(section.path === 'advanced'
        ? {
            // Offered by the route, where the platform question is answered, so the one dynamic
            // import that pulls CodeMirror in is wired here; a section rendered without this
            // route (a spec) still edits in its textarea without touching that chunk.
            providers: [provideConfigEditor()],
          }
        : {}),
    })),
  },
];
