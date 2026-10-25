import { Routes } from '@angular/router';
import {
  authGuard,
  deviceConfirmationGuard,
  workspaceBrowserBackGuard,
} from '@trinity/application/runtime';
// Type-only: a value import here would pull the lazy crypto feature into the initial
// bundle, which is the whole point of loadComponent below.
import type {
  EncryptionSetupPage,
  EncryptionUnlockPage,
} from '@trinity/feature/crypto';

export const routes: Routes = [
  {
    path: 'login',
    canDeactivate: [workspaceBrowserBackGuard],
    loadComponent: () =>
      import('@trinity/feature/auth').then((m) => m.LoginPage),
  },
  {
    path: 'sso-callback',
    canDeactivate: [workspaceBrowserBackGuard],
    loadComponent: () =>
      import('@trinity/feature/auth').then((m) => m.SsoCallbackPage),
  },
  {
    path: 'register',
    canDeactivate: [workspaceBrowserBackGuard],
    loadComponent: () =>
      import('@trinity/feature/auth').then((m) => m.RegistrationPage),
  },
  {
    path: 'reset-password',
    canDeactivate: [workspaceBrowserBackGuard],
    loadComponent: () =>
      import('@trinity/feature/auth').then((m) => m.ResetPasswordPage),
  },
  // `/rooms` and `/rooms/<segment>` are ONE route, via a matcher rather than two entries:
  // Angular's DefaultRouteReuseStrategy compares `routeConfig` by identity, so two entries
  // sharing a `loadComponent` would destroy and rebuild `RoomsPage` on every open-a-room and
  // close-back-to-the-list. Its `providers` hold `RoomShellStore` and the shell coordinators,
  // so a rebuild resets the selected space, sidebar view and room filter.
  //
  // The segment is base64url, not the raw room id (see `encodeRoomSegment`): a raw id ends in a
  // dotted server name, which both SPA fallbacks refuse to answer with index.html.
  {
    matcher: (segments) => {
      if (segments.length === 0 || segments[0].path !== 'rooms') {
        return null;
      }
      if (segments.length === 1) {
        return { consumed: segments };
      }
      if (segments.length === 2) {
        return { consumed: segments, posParams: { roomId: segments[1] } };
      }
      return null;
    },
    // The new-device check runs last, so a Back press that only closes a dialog never
    // waits for it.
    canActivate: [
      authGuard,
      workspaceBrowserBackGuard,
      deviceConfirmationGuard,
    ],
    canDeactivate: [workspaceBrowserBackGuard],
    runGuardsAndResolvers: 'always',
    loadComponent: () =>
      import('@trinity/feature/rooms').then((m) => m.RoomsPage),
  },
  {
    path: 'settings',
    canActivate: [authGuard],
    // Children re-run the new-device check on every section change; it lets Security
    // through, which stays reachable from the check.
    canActivateChild: [workspaceBrowserBackGuard, deviceConfirmationGuard],
    canDeactivate: [workspaceBrowserBackGuard],
    loadChildren: () =>
      import('@trinity/feature/settings').then((m) => m.settingsRoutes),
  },
  {
    path: 'encryption/setup',
    canActivate: [authGuard],
    // Same shown-once key as the unlock route below, on the path EVERY new account takes:
    // first-run setup displays the recovery key once and never persists it, and the
    // browser's back button would drop it without a word. These guards need the router's
    // canceledNavigationResolution: 'computed' (trinity-application.providers.ts).
    canDeactivate: [(page: EncryptionSetupPage) => page.confirmLeave()],
    loadComponent: () =>
      import('@trinity/feature/crypto').then((m) => m.EncryptionSetupPage),
  },
  {
    path: 'encryption/unlock',
    canActivate: [authGuard],
    // Same guard, one extra risk: a reset shows its new recovery key exactly once AND cannot
    // be cancelled once running, while the routed page (what narrow layouts get) is dismissed
    // by the browser's back button without asking. The desktop modal's in-page Close can ask.
    // Does not cover a tab close or reload (beforeunload cannot show our copy).
    canDeactivate: [(page: EncryptionUnlockPage) => page.confirmLeave()],
    loadComponent: () =>
      import('@trinity/feature/crypto').then((m) => m.EncryptionUnlockPage),
  },
  {
    path: 'encryption/verify',
    canActivate: [authGuard],
    canDeactivate: [workspaceBrowserBackGuard],
    loadComponent: () =>
      import('@trinity/feature/crypto').then((m) => m.DeviceVerificationPage),
  },
  {
    // A new device of an Account with an identity is verified here before the app opens
    // (MSC4153). The screen routes to unlock and verify, which come back via returnTo.
    path: 'encryption/confirm',
    canActivate: [authGuard],
    canDeactivate: [workspaceBrowserBackGuard],
    loadComponent: () =>
      import('@trinity/feature/crypto').then((m) => m.DeviceConfirmationPage),
  },
  {
    path: '',
    redirectTo: 'rooms',
    pathMatch: 'full',
  },
  // The service worker answers EVERY same-origin navigation with index.html, so a stale
  // bookmark or an old share link boots the shell against a path no route matches —
  // without this the app renders an empty outlet forever. authGuard on /rooms sends a
  // signed-out user on to /login, so one redirect covers both states.
  {
    path: '**',
    redirectTo: 'rooms',
  },
];
