import { InjectionToken } from '@angular/core';
import type { HostOperationOutcome } from '@trinity/runtime/host';
import type { Observable } from 'rxjs';

/** Host-neutral output boundary for the application Badge workflow. */
export interface BadgeSink {
  write(count: number): Observable<HostOperationOutcome>;
}

export const BADGE_SINK = new InjectionToken<BadgeSink>('BADGE_SINK');
