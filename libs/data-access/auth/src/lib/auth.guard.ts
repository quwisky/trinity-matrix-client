import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { Observable, catchError, map, of } from 'rxjs';
import { AccountRuntimeService } from '@trinity/data-access/accounts';

/**
 * Allows navigation only when an Active Account is live, restoring every persisted
 * Account through Account Runtime first.
 * Redirects to /login when nothing is stored.
 *
 * The Router unsubscribes a guard whose navigation is superseded (a deep link arriving
 * during the initial restore), which cancels this cold observable mid-restore. That is safe
 * because Account Runtime records the cancelled terminal state while Matrix Runtime rolls
 * back any client that had not committed.
 */
export const authGuard: CanActivateFn = (): Observable<boolean | UrlTree> => {
  const accounts = inject(AccountRuntimeService);
  const router = inject(Router);

  if (accounts.hasActiveAccount()) {
    return of(true);
  }

  return accounts.restoreSavedAccounts().pipe(
    map((result) =>
      result.kind === 'restored' ||
      result.kind === 'restored-with-inactive-failures'
        ? true
        : router.createUrlTree(['/login']),
    ),
    catchError(() => of(router.createUrlTree(['/login']))),
  );
};
