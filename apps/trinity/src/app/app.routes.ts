import { Routes } from '@angular/router';
import { authGuard } from '@trinity/core';

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
    // Dev-only E2EE crypto spike (Milestone 1 harness).
    path: 'spike',
    loadComponent: () => import('./home/home.page').then((m) => m.HomePage),
  },
  {
    path: '',
    redirectTo: 'rooms',
    pathMatch: 'full',
  },
];
