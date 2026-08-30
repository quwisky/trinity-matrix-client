import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { Observable, catchError, map, of } from 'rxjs';
import { AccountRuntimeService } from '@trinity/data-access/accounts';

/**
 * Allows navigation only when an Active Account is live, restoring persisted Accounts
 * when initial navigation reaches the guard before Application Runtime has settled.
 */
export const authGuard: CanActivateFn = (): Observable<boolean | UrlTree> => {
  const accounts = inject(AccountRuntimeService);
  const router = inject(Router);

  if (accounts.hasActiveAccount()) {
    return of(true);
  }
  if (accounts.state().phase === 'settled') {
    return of(router.createUrlTree(['/login']));
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
