import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { WorkspaceBackService } from '@trinity/application/workspace';
import { TrnDialogService } from '@trinity/components/overlay';
import { map, take, type Observable } from 'rxjs';
import { WorkspaceRoutedSurfaceAdapter } from './composition/workspace-routed-surface.adapter';

/** Offer browser-history navigation to the active semantic surface before changing routes. */
export function workspaceBrowserBackGuard(): boolean | Observable<boolean> {
  const router = inject(Router);
  const back = inject(WorkspaceBackService);
  const dialog = inject(TrnDialogService);
  const routed = inject(WorkspaceRoutedSurfaceAdapter);
  if (router.currentNavigation()?.trigger !== 'popstate') {
    return true;
  }
  if (dialog.hasOpen() && !back.activeOwnsTopmostOverlay()) {
    dialog.closeTopmost();
    return false;
  }
  // A popstate has already consumed browser history. During the guard, the routed
  // adapter still exposes the old application surface until NavigationEnd; offering
  // it to Workspace here would consume history a second time and veto the route.
  if (!dialog.hasOpen()) {
    const active = back.activeSurface();
    if (active !== null && routed.owns(active)) return true;
  }
  if (back.hasActive()) {
    return back.back().pipe(
      take(1),
      map(() => false),
    );
  }
  if (!dialog.hasOpen()) return true;
  dialog.closeTopmost();
  return false;
}
