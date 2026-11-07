import { inject } from '@angular/core';
import { CanActivateFn, RedirectCommand, Router } from '@angular/router';
import { Observable, catchError, map, of } from 'rxjs';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

/**
 * Allows navigation only when an Active Account is live, restoring persisted Accounts
 * when initial navigation reaches the guard before Application Runtime has settled.
 */
export const authGuard: CanActivateFn = (): Observable<
  boolean | RedirectCommand
> => {
  const accounts = inject(AccountRuntimeService);
  const matrix = inject(MatrixClientService);
  const router = inject(Router);
  const login = (): RedirectCommand => {
    const target = matrix.reauthTargets()[0];
    const tree = target
      ? router.createUrlTree(['/login'], { queryParams: { reauth: target } })
      : router.createUrlTree(['/login']);
    // Reload: a retried startup already showing /login must still end its navigation,
    // and a same-URL redirect does not inherit the retry's own onSameUrlNavigation.
    return new RedirectCommand(tree, { onSameUrlNavigation: 'reload' });
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
