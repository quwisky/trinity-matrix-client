import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { Observable, catchError, map, of } from 'rxjs';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

/**
 * Allows navigation only when an Active Account is live, restoring persisted Accounts
 * when initial navigation reaches the guard before Application Runtime has settled.
 */
export const authGuard: CanActivateFn = (): Observable<boolean | UrlTree> => {
  const accounts = inject(AccountRuntimeService);
  const matrix = inject(MatrixClientService);
  const router = inject(Router);
  const login = (): UrlTree => {
    const target = matrix.reauthTargets()[0];
    return target
      ? router.createUrlTree(['/login'], { queryParams: { reauth: target } })
      : router.createUrlTree(['/login']);
  };

  if (accounts.hasActiveAccount()) {
    return of(true);
  }
  if (accounts.state().phase === 'settled') {
    return of(login());
  }

  return accounts.restoreSavedAccounts().pipe(
    map((result) =>
      result.kind === 'restored' ||
      result.kind === 'restored-with-inactive-failures'
        ? true
        : login(),
    ),
    catchError(() => of(login())),
  );
};
