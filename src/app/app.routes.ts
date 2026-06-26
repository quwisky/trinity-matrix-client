import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'sso-callback',
    loadComponent: () =>
      import('./features/auth/sso-callback.page').then((m) => m.SsoCallbackPage),
  },
  {
    path: 'rooms',
    canActivate: [authGuard],
    loadComponent: () => import('./features/rooms/rooms.page').then((m) => m.RoomsPage),
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
