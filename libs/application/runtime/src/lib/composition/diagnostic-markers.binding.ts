import { Injectable, computed, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { DiagnosticLogService } from '@trinity/data-access/diagnostic-log';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { HostLifecycleService } from '@trinity/runtime/host';
import {
  distinctUntilChanged,
  filter,
  ignoreElements,
  map,
  merge,
  tap,
  type Observable,
} from 'rxjs';

/**
 * Lifecycle markers that anchor the diagnostic log's timeline: how many accounts are
 * signed in, the active account's sync state, and foreground/background. Application
 * Runtime owns the lifetime (`startApplicationRuntime`); the log owns start and page hide.
 */
@Injectable({ providedIn: 'root' })
export class DiagnosticMarkersBinding {
  private readonly log = inject(DiagnosticLogService);
  private readonly matrix = inject(SessionStateService);
  private readonly lifecycle = inject(HostLifecycleService);
  private readonly accountCount = toObservable(
    computed(() => this.matrix.accountIds().length),
  );
  private readonly syncState = toObservable(this.matrix.syncState);

  run(): Observable<never> {
    return merge(
      this.accountCount.pipe(
        distinctUntilChanged(),
        map((count) => `accounts signed in: ${count}`),
      ),
      this.syncState.pipe(
        filter((state) => state !== null && state !== 'starting'),
        distinctUntilChanged(),
        map((state) => `sync state (active account): ${state.toUpperCase()}`),
      ),
      this.lifecycle.events.pipe(
        map((event) =>
          event.kind === 'active' ? 'app in foreground' : 'app in background',
        ),
      ),
    ).pipe(
      tap((message) =>
        this.log.record({
          level: 'info',
          source: 'app',
          logger: 'lifecycle',
          message,
        }),
      ),
      ignoreElements(),
    );
  }
}
