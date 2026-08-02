import { Routes } from '@angular/router';
import { authGuard } from '@trinity/data-access/auth';
// Type-only: a value import here would pull the lazy crypto feature into the initial
// bundle, which is the whole point of loadComponent below.
import type {
  EncryptionSetupPage,
  EncryptionUnlockPage,
} from '@trinity/feature/crypto';
import { environment } from '../environments/environment';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('@trinity/feature/auth').then((m) => m.LoginPage),
  },
  {
    path: 'sso-callback',
    loadComponent: () =>
      import('@trinity/feature/auth').then((m) => m.SsoCallbackPage),
  },
  {
    path: 'rooms',
    canActivate: [authGuard],
    loadComponent: () =>
      import('@trinity/feature/rooms').then((m) => m.RoomsPage),
  },
  {
    path: 'settings',
    canActivate: [authGuard],
    loadChildren: () =>
      import('@trinity/feature/settings').then((m) => m.settingsRoutes),
  },
  {
    path: 'encryption/setup',
    canActivate: [authGuard],
    // Same shown-once key as the unlock route below, on the path EVERY new account
    // takes: first-run setup displays the recovery key once and never persists it, and
    // the browser's back button would drop it without a word. (See main.ts for the
    // router config these guards need.)
    canDeactivate: [(page: EncryptionSetupPage) => page.confirmLeave()],
    loadComponent: () =>
      import('@trinity/feature/crypto').then((m) => m.EncryptionSetupPage),
  },
  {
    path: 'encryption/unlock',
    canActivate: [authGuard],
    // Same guard, one extra risk: a reset shows its new recovery key exactly once AND
    // cannot be cancelled once it is running, while the routed page — what every narrow
    // layout gets — is dismissed by the browser's own back button, which tears the
    // component down without asking anyone. The desktop modal has an in-page Close that
    // can ask; this is the same question for the path most users are on. It does not
    // cover a tab close or reload (that needs beforeunload, which cannot show our copy).
    canDeactivate: [(page: EncryptionUnlockPage) => page.confirmLeave()],
    loadComponent: () =>
      import('@trinity/feature/crypto').then((m) => m.EncryptionUnlockPage),
  },
  {
    path: 'encryption/verify',
    canActivate: [authGuard],
    loadComponent: () =>
      import('@trinity/feature/crypto').then((m) => m.DeviceVerificationPage),
  },
  // Dev-only E2EE crypto spike (Milestone 1 harness; driven by `pnpm spike:chromium`).
  // Deep-imported rather than taken from the @trinity/feature/shell barrel ON PURPOSE:
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
            import('@trinity/feature/shell/home-page').then((m) => m.HomePage),
        },
      ]),
  {
    path: '',
    redirectTo: 'rooms',
    pathMatch: 'full',
  },
];
