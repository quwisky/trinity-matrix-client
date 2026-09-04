import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import type { WorkspaceNavigationActivator } from '@trinity/application/workspace';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { Observable, defer, from, map } from 'rxjs';

/** Mounts the lazy Room shell so the semantic Workspace implementation can register. */
@Injectable({ providedIn: 'root' })
export class WorkspaceNavigationActivatorAdapter implements WorkspaceNavigationActivator {
  private readonly router = inject(Router);
  private readonly accounts = inject(AccountRuntimeService);

  activate(): Observable<{ readonly kind: 'ready' | 'unavailable' }> {
    return defer(() => {
      const accountId = this.accounts.activeAccountId();
      return from(
        this.router.navigate(['/rooms'], {
          // Keep the current browser entry until Workspace projects the exact intent.
          skipLocationChange: true,
          ...(accountId ? { queryParams: { account: accountId } } : {}),
        }),
      ).pipe(
        map((accepted) => ({
          kind: accepted ? ('ready' as const) : ('unavailable' as const),
        })),
      );
    });
  }
}
