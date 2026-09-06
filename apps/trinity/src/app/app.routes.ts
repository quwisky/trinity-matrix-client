import { Routes } from '@angular/router';
import {
  authGuard,
  workspaceBrowserBackGuard,
} from '@trinity/application/runtime';
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
    path: 'register',
    loadComponent: () =>
      import('@trinity/feature/auth').then((m) => m.RegistrationPage),
  },
  // `/rooms` and `/rooms/<segment>` as ONE route, via a matcher rather than two entries.
  //
  // Two sibling entries sharing a `loadComponent` do NOT share a component instance: Angular's
  // DefaultRouteReuseStrategy is `future.routeConfig === curr.routeConfig`, an identity check on
  // the Route OBJECT, so two entries are two configs and every open-a-room and close-back-to-the
  // -list would destroy `RoomsPage` and rebuild it. That page's `providers` hold `RoomShellStore`
  // and the twelve shell coordinators, so a rebuild resets the selected space, the sidebar view
  // and the room filter — clicking a room inside a space would snap the sidebar back to Recent.
  // One config means one `routeConfig`, so the instance is reused across both URLs.
  //
  // The segment is base64url, not the raw room id — see `encodeRoomSegment`. A raw id ends in a
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
    canActivate: [authGuard, workspaceBrowserBackGuard],
    canDeactivate: [workspaceBrowserBackGuard],
    runGuardsAndResolvers: 'always',
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
  // The route stays lazy and development-only. esbuild does not constant-fold
  // `environment.production`, so the ternary removes the route at runtime while the
  // dynamic import keeps the crypto harness out of the eager application chunk.
  ...(environment.production
    ? []
    : [
        {
          path: 'spike',
          loadComponent: () =>
            import('@trinity/feature/shell').then((m) => m.HomePage),
        },
      ]),
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
