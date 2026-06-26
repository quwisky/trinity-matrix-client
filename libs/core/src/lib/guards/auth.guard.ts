import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { MatrixClientService } from '../matrix/matrix-client.service';
import { SessionStorageService } from '../storage/session-storage.service';

/**
 * Allows navigation only when a Matrix client is live, attempting a one-time
 * session restore first. Redirects to /login otherwise.
 */
export const authGuard: CanActivateFn = async () => {
  const matrix = inject(MatrixClientService);
  const storage = inject(SessionStorageService);
  const router = inject(Router);

  if (matrix.isInitialized) {
    return true;
  }

  const session = await storage.load();
  if (session) {
    await matrix.init(session);
    return true;
  }

  return router.createUrlTree(['/login']);
};
