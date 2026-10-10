import { inject } from '@angular/core';
import { Router } from '@angular/router';
import {
  WorkspaceBackService,
  WorkspaceNavigationService,
} from '@trinity/application/workspace';
import { TrnSurfaceService } from '@trinity/components/overlay';
import { map, take, type Observable } from 'rxjs';
import { WorkspaceRoutedSurfaceAdapter } from './composition/workspace-routed-surface.adapter';

/** Offer browser-history navigation to the active semantic surface before changing routes. */
export function workspaceBrowserBackGuard(): boolean | Observable<boolean> {
  const router = inject(Router);
  const back = inject(WorkspaceBackService);
  const dialog = inject(TrnSurfaceService);
  const routed = inject(WorkspaceRoutedSurfaceAdapter);
  const workspace = inject(WorkspaceNavigationService);
  if (router.currentNavigation()?.trigger !== 'popstate') {
    return true;
  }
  // Workspace's own Back popped history (a Conversation over its list): let it land.
  if (workspace.projectingLocation) return true;
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
    // A Conversation pushed over its list: this history step lands on that list (#1113).
    if (active?.layer === 'conversation' && workspace.conversationOverList())
      return true;
  }
  if (back.hasActive()) {
    // `hasActive` is a cached projection; `back()` re-reads the surface when it runs. If
    // nothing handles Back by then, the browser's own history move stands.
    return back.back().pipe(
      take(1),
      map((outcome) => outcome.kind === 'unhandled'),
    );
  }
  if (!dialog.hasOpen()) return true;
  dialog.closeTopmost();
  return false;
}
