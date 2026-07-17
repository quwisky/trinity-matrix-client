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
    loadChildren: () =>
      import('@trinity/feature-settings').then((m) => m.settingsRoutes),
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
  // Dev-only E2EE crypto spike (Milestone 1 harness; driven by `pnpm spike:chromium`).
  // Deep-imported rather than taken from the @trinity/feature-shell barrel ON PURPOSE:
  // main.ts imports that barrel eagerly for AppComponent, so a barrel import here would
  // merge the harness into the eager chunk. esbuild does not constant-fold
  // `environment.production`, so the ternary alone does NOT strip the import — the route
  // is absent at runtime in prod, but the code would still ship and be SW-precached.
  ...(environment.production
    ? []
    : [
        {
          path: 'spike',
          loadComponent: () =>
            import('@trinity/feature-shell/home-page').then((m) => m.HomePage),
        },
      ]),
  {
    path: '',
    redirectTo: 'rooms',
    pathMatch: 'full',
  },
];
