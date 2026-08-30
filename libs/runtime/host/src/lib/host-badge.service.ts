import { Injectable, InjectionToken, inject } from '@angular/core';
import { Observable, defaultIfEmpty, defer, of, take } from 'rxjs';
import type {
  HostBadgeOperation,
  HostCapabilitySupport,
  HostOperationOutcome,
} from './host-capability.models';

export const HOST_BADGE_OPERATION = new InjectionToken<HostBadgeOperation>(
  'HOST_BADGE_OPERATION',
);

const MAX_BADGE_COUNT = 9999;

/** Product-facing badge operation; host selection and platform checks stay behind its seam. */
@Injectable({ providedIn: 'root' })
export class HostBadgeService implements HostBadgeOperation {
  private readonly adapter = inject(HOST_BADGE_OPERATION, { optional: true });

  support(): Observable<HostCapabilitySupport> {
    return defer(() =>
      this.adapter
        ? this.adapter.support().pipe(
            take(1),
            defaultIfEmpty({
              kind: 'unavailable',
              reason: 'host-rejected',
              diagnostic: { code: 'empty-badge-support' },
            } as const),
          )
        : of({ kind: 'unavailable', reason: 'not-implemented' } as const),
    );
  }

  set(count: number): Observable<HostOperationOutcome> {
    return defer(() => {
      if (!this.adapter) {
        return of({ kind: 'unavailable', reason: 'not-implemented' } as const);
      }
      const normalized = Math.min(
        Math.max(Math.trunc(Number.isFinite(count) ? count : 0), 0),
        MAX_BADGE_COUNT,
      );
      return this.adapter.set(normalized).pipe(
        take(1),
        defaultIfEmpty({
          kind: 'rejected',
          diagnostic: { code: 'empty-badge-operation' },
        } as const),
      );
    });
  }
}
