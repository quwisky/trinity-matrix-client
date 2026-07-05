import { Routes } from '@angular/router';
import { authGuard } from '@trinity/data-access-auth';
import { environment } from '../environments/environment';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('@trinity/feature-auth').then((m) => m.LoginPage),
  },
  {
    path: 'sso-callback',
    loadComponent: () =>
      import('@trinity/feature-auth').then((m) => m.SsoCallbackPage),
  },
  {
    path: 'rooms',
    canActivate: [authGuard],
    loadComponent: () =>
      import('@trinity/feature-rooms').then((m) => m.RoomsPage),
  },
  {
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () =>
      import('@trinity/feature-settings').then((m) => m.SettingsPage),
  },
  {
    path: 'encryption/setup',
    canActivate: [authGuard],
    loadComponent: () =>
      import('@trinity/feature-crypto').then((m) => m.EncryptionSetupPage),
  },
  {
    path: 'encryption/unlock',
    canActivate: [authGuard],
    loadComponent: () =>
      import('@trinity/feature-crypto').then((m) => m.EncryptionUnlockPage),
  },
  {
    path: 'encryption/verify',
    canActivate: [authGuard],
    loadComponent: () =>
      import('@trinity/feature-crypto').then((m) => m.DeviceVerificationPage),
  },
  // Dev-only E2EE crypto spike (Milestone 1 harness) — excluded from prod builds,
  // so the harness page and CryptoSpikeService tree-shake out of the production bundle.
  ...(environment.production
    ? []
    : [
        {
          path: 'spike',
          loadComponent: () =>
            import('@trinity/feature-shell').then((m) => m.HomePage),
        },
      ]),
  {
    path: '',
    redirectTo: 'rooms',
    pathMatch: 'full',
  },
];
