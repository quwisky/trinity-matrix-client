import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { Observable, catchError, map, of, switchMap } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { SessionStorageService } from '@trinity/platform-native';

/**
 * Allows navigation only when a Matrix client is live, attempting a one-time
 * session restore first. Redirects to /login otherwise.
 */
export const authGuard: CanActivateFn = (): Observable<boolean | UrlTree> => {
  const matrix = inject(MatrixClientService);
  const storage = inject(SessionStorageService);
  const router = inject(Router);

  if (matrix.isInitialized) {
    return of(true);
  }

  return storage.load().pipe(
    switchMap((session) =>
      session
        ? matrix.init(session).pipe(map(() => true))
        : of(router.createUrlTree(['/login'])),
    ),
    catchError(() => of(router.createUrlTree(['/login']))),
  );
};
