import { inject } from '@angular/core';
import {
  Router,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
  type UrlTree,
} from '@angular/router';
import {
  Observable,
  catchError,
  forkJoin,
  map,
  of,
  switchMap,
  timeout,
} from 'rxjs';
import {
  DEVICE_CONFIRMATION_SETTLE_MS,
  TrustDeviceConfirmationService,
  TrustSlotForecastService,
} from '@trinity/data-access/trust';

/** The longest the guard waits for the active Account's banner forecast. */
export const FORECAST_HYDRATE_MS = 300;

/** Where a new device is verified before the app opens. */
export const DEVICE_CONFIRMATION_URL = '/encryption/confirm';

/** A URL's path, without its query or fragment. */
function pathOf(url: string): string {
  return url.split(/[?#]/, 1)[0] ?? '';
}

/** Security settings stay reachable from the check. */
export function isSecuritySettings(url: string): boolean {
  return pathOf(url) === '/settings/security';
}

/**
 * Routes the check closes: Rooms and every Settings section but Security. The guard
 * covers them through the route config; the coordinator uses this for a late redirect.
 */
export function showsAccountContent(url: string): boolean {
  if (isSecuritySettings(url)) return false;
  const path = pathOf(url);
  return (
    path === '/rooms' ||
    path.startsWith('/rooms/') ||
    path === '/settings' ||
    path.startsWith('/settings/')
  );
}

/**
 * Following MSC4153, a new device is verified before the app opens: keeps Rooms and every
 * Settings section but Security closed while the active Account's new device still needs
 * verifying. Waits at most `DEVICE_CONFIRMATION_SETTLE_MS` for the first status read, then
 * lets the route through;
 * the session coordinator redirects if the check turns out to be required later. A
 * `required` gate is confirmed with a fresh read of that exact Account, because just after
 * an Account switch it can still reflect the previous Account's status. A failed read, or
 * one that takes longer than the settle time, lets the route through too. Meanwhile it
 * loads the active Account's banner forecast, so Rooms first renders with the global
 * banner slot already sized; that read waits at most `FORECAST_HYDRATE_MS` and fails
 * open. Use it after `authGuard` and the Back guard.
 */
export function deviceConfirmationGuard(
  _route: ActivatedRouteSnapshot,
  state: RouterStateSnapshot,
): Observable<boolean | UrlTree> {
  if (isSecuritySettings(state.url)) return of(true);
  const confirmation = inject(TrustDeviceConfirmationService);
  const router = inject(Router);
  const forecastRead = inject(TrustSlotForecastService)
    .hydrateActive()
    .pipe(
      timeout({ first: FORECAST_HYDRATE_MS, with: () => of(undefined) }),
      catchError(() => of(undefined)),
    );
  const decision = confirmation.settledGate().pipe(
    switchMap((gate) =>
      gate.kind === 'required'
        ? confirmation.confirmRequired().pipe(
            timeout({
              first: DEVICE_CONFIRMATION_SETTLE_MS,
              with: () => of(false),
            }),
          )
        : of(false),
    ),
    map((required) =>
      required ? router.createUrlTree([DEVICE_CONFIRMATION_URL]) : true,
    ),
    catchError(() => of(true)),
  );
  return forkJoin([forecastRead, decision]).pipe(map(([, result]) => result));
}
