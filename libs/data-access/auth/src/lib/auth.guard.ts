import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { Observable, catchError, map, of } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

/**
 * Allows navigation only when a Matrix client is live, restoring the persisted
 * accounts first (the active one, plus the rest warmed in the background).
 * Redirects to /login when nothing is stored.
 *
 * The Router unsubscribes a guard whose navigation is superseded (a deep link arriving
 * during the initial restore), which cancels this cold observable mid-restore. That is safe
 * because MatrixClientService.start() owns it: a cancelled start rolls its client back, and
 * a second start for the same account joins the first. Do not add cancellation handling here.
 */
export const authGuard: CanActivateFn = (): Observable<boolean | UrlTree> => {
  const matrix = inject(MatrixClientService);
  const router = inject(Router);

  if (matrix.isInitialized) {
    return of(true);
  }

  return matrix.restoreAll().pipe(
    map((restored) => (restored ? true : router.createUrlTree(['/login']))),
    catchError(() => of(router.createUrlTree(['/login']))),
  );
};
