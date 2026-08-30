import { InjectionToken, Injectable, inject } from '@angular/core';
import { Observable, defaultIfEmpty, defer, of, take } from 'rxjs';
import type {
  WorkspaceApplicationSurfaceOutcome,
  WorkspaceApplicationSurfaceRequest,
} from './workspace-surface.models';

/** Host adapter allowed to name Router, platform policy, lazy features, and UI vendors. */
export interface WorkspaceApplicationSurfacePresenter {
  present(
    request: WorkspaceApplicationSurfaceRequest,
  ): Observable<WorkspaceApplicationSurfaceOutcome>;
}

export const WORKSPACE_APPLICATION_SURFACE_PRESENTER =
  new InjectionToken<WorkspaceApplicationSurfacePresenter>(
    'WORKSPACE_APPLICATION_SURFACE_PRESENTER',
  );

/** Application-facing command port for opening semantic Workspace surfaces. */
@Injectable({ providedIn: 'root' })
export class WorkspaceApplicationSurfaceService {
  private readonly presenter = inject(WORKSPACE_APPLICATION_SURFACE_PRESENTER, {
    optional: true,
  });

  /** Cold, finite presentation; an unwired host reports unavailable without throwing. */
  open(
    request: WorkspaceApplicationSurfaceRequest,
  ): Observable<WorkspaceApplicationSurfaceOutcome> {
    return defer(() => {
      if (!this.presenter) {
        return of({ kind: 'unavailable', surface: request.surface } as const);
      }
      return this.presenter.present(request).pipe(
        take(1),
        defaultIfEmpty({
          kind: 'unavailable',
          surface: request.surface,
        } as const),
      );
    });
  }
}
