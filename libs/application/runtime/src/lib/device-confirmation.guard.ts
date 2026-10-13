import { inject } from '@angular/core';
import {
  Router,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
  type UrlTree,
} from '@angular/router';
import { Observable, catchError, map, of, switchMap } from 'rxjs';
import { TrustDeviceConfirmationService } from '@trinity/data-access/trust';

/** Where a new device is verified before the app opens. */
export const DEVICE_CONFIRMATION_URL = '/encryption/confirm';

/** A URL's path, without its query or fragment. */
function pathOf(url: string): string {
  return url.split(/[?#]/, 1)[0] ?? '';
}

/** Security settings stay reachable from the check (2026-10-12 decision 3). */
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
 * Keeps Rooms and every Settings section but Security closed while the active Account's
 * new device still needs verifying (MSC4153 decision 2). Waits at most
 * `DEVICE_CONFIRMATION_SETTLE_MS` for the first status read, then lets the route through;
 * the session coordinator redirects if the check turns out to be required later. A
 * `required` gate is confirmed with a fresh read of that exact Account, because just after
 * an Account switch it can still reflect the previous Account's status. A failed read lets
 * the route through too. Use it after `authGuard` and the Back guard.
 */
export function deviceConfirmationGuard(
  _route: ActivatedRouteSnapshot,
  state: RouterStateSnapshot,
): Observable<boolean | UrlTree> {
  if (isSecuritySettings(state.url)) return of(true);
  const confirmation = inject(TrustDeviceConfirmationService);
  const router = inject(Router);
  return confirmation.settledGate().pipe(
    switchMap((gate) =>
      gate.kind === 'required' ? confirmation.confirmRequired() : of(false),
    ),
    map((required) =>
      required ? router.createUrlTree([DEVICE_CONFIRMATION_URL]) : true,
    ),
    catchError(() => of(true)),
  );
}
