import {
  Injectable,
  Injector,
  type Signal,
  computed,
  inject,
} from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { SpacesService } from '@trinity/data-access/room-library';
import {
  EMPTY,
  type Observable,
  catchError,
  concatMap,
  defer,
  distinctUntilChanged,
  filter,
  ignoreElements,
} from 'rxjs';
import type { WorkspaceView } from './workspace-navigation.models';
import { WorkspaceAvailability } from './workspace-availability';
import { WorkspaceTransitionWorkflow } from './workspace-transition.workflow';

/**
 * Package-internal: which committed views need their Space repaired to Recent.
 *
 * A view qualifies once its Space is unavailable: the Account has synced without it
 * (#1401), or it disappeared (#1402: removed, left elsewhere, or its holder unticked in
 * the mixed view). Nothing qualifies while a transition owns the view, while this app's
 * own leave of the Space is in flight (that flow navigates itself), or while the view's
 * Account is not the active one (a switch or sign-out is under way).
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceSpaceRepair {
  private readonly accounts = inject(AccountRuntimeService);
  private readonly workflow = inject(WorkspaceTransitionWorkflow);
  private readonly availability = inject(WorkspaceAvailability);
  private readonly spaces = inject(SpacesService);
  private readonly injector = inject(Injector);

  /**
   * Each committed view whose Space has become unavailable, once per view: a view whose
   * repair was rejected is not offered again, even if its Space comes back and goes again
   * before another view commits. The caller still checks the view is current before acting.
   */
  unavailableViews(view: Signal<WorkspaceView>): Observable<WorkspaceView> {
    const unavailable = computed(() => {
      const current = view();
      if (current.scope.kind !== 'space' || !current.accountId) return null;
      if (this.workflow.busy()) return null;
      if (current.accountId !== this.accounts.activeAccountId()) return null;
      if (this.spaces.isLeaving(current.accountId, current.scope.spaceId)) {
        return null;
      }
      return this.availability.space(
        current.accountId,
        current.scope.spaceId,
      ) === 'unavailable'
        ? current
        : null;
    });
    return toObservable(unavailable, { injector: this.injector }).pipe(
      filter((current): current is WorkspaceView => current !== null),
      distinctUntilChanged(),
    );
  }

  /**
   * Repair each such view with `repair`, one at a time. A failed repair leaves the view as
   * it is, and the watch outlives it.
   */
  run(
    view: Signal<WorkspaceView>,
    repair: (view: WorkspaceView) => Observable<unknown>,
  ): Observable<never> {
    return this.unavailableViews(view).pipe(
      concatMap((current) =>
        defer(() => repair(current)).pipe(catchError(() => EMPTY)),
      ),
      ignoreElements(),
    );
  }
}
