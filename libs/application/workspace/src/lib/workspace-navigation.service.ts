import { Injectable, InjectionToken, inject } from '@angular/core';
import { Observable, defaultIfEmpty, defer, of, switchMap, take } from 'rxjs';
import type {
  WorkspaceNavigation,
  WorkspaceNavigationIntent,
  WorkspaceNavigationOutcome,
} from './workspace-navigation.models';

export interface WorkspaceNavigationActivator {
  activate(): Observable<{ readonly kind: 'ready' | 'unavailable' }>;
}

export const WORKSPACE_NAVIGATION_ACTIVATOR =
  new InjectionToken<WorkspaceNavigationActivator>(
    'WORKSPACE_NAVIGATION_ACTIVATOR',
  );

/** Application-facing relay to the currently mounted Workspace implementation. */
@Injectable({ providedIn: 'root' })
export class WorkspaceNavigationService implements WorkspaceNavigation {
  private readonly activator = inject(WORKSPACE_NAVIGATION_ACTIVATOR, {
    optional: true,
  });
  private implementation: WorkspaceNavigation | null = null;

  register(implementation: WorkspaceNavigation): () => void {
    this.implementation = implementation;
    return () => {
      if (this.implementation === implementation) this.implementation = null;
    };
  }

  navigate(
    intent: WorkspaceNavigationIntent,
  ): Observable<WorkspaceNavigationOutcome> {
    return defer(() => {
      if (this.implementation) return this.execute(this.implementation, intent);
      if (!this.activator) return of(unavailable());
      return this.activator.activate().pipe(
        take(1),
        defaultIfEmpty({ kind: 'unavailable' } as const),
        switchMap((activation) => {
          const implementation = this.implementation;
          return activation.kind === 'ready' && implementation
            ? this.execute(implementation, intent)
            : of(unavailable());
        }),
      );
    });
  }

  private execute(
    implementation: WorkspaceNavigation,
    intent: WorkspaceNavigationIntent,
  ): Observable<WorkspaceNavigationOutcome> {
    return implementation
      .navigate(intent)
      .pipe(take(1), defaultIfEmpty(unavailable()));
  }
}

function unavailable(): WorkspaceNavigationOutcome {
  return { kind: 'unavailable', reason: 'navigation-rejected' };
}
