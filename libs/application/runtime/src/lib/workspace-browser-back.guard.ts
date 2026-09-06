import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { WorkspaceBackService } from '@trinity/application/workspace';
import { TrnDialogService } from '@trinity/components/overlay';
import { map, take, type Observable } from 'rxjs';

/** Offer browser-history navigation to the active semantic surface before changing routes. */
export function workspaceBrowserBackGuard(): boolean | Observable<boolean> {
  const router = inject(Router);
  const back = inject(WorkspaceBackService);
  const dialog = inject(TrnDialogService);
  if (router.currentNavigation()?.trigger !== 'popstate') {
    return true;
  }
  if (dialog.hasOpen() && !back.activeOwnsTopmostOverlay()) {
    dialog.closeTopmost();
    return false;
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
