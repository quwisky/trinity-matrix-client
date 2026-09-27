import { Injectable, inject } from '@angular/core';
import { BELOW_MD_QUERY, matchesQuery } from '@trinity/util/ui';
import { WorkspaceLocationAdapter } from './workspace-location.adapter';
import { resolveWorkspaceNavigation } from './workspace-navigation.resolver';
import { WorkspaceNavigationService } from './workspace-navigation.service';
import type { WorkspaceConversationSurface } from './workspace-surface.models';

/**
 * The browser-history side of the Workspace Back policy.
 *
 * A browser Back arrives as a Router traversal that has already moved the address bar. Leaving the
 * compact Conversation must still show its list pane, but a Workspace command started from the
 * traversal's own guard would supersede it, cancel the command's attempt and roll the Room URL
 * back over the entry Back reached. The Router therefore redirects the traversal to the URL
 * answered here in one replacing navigation, and Workspace restores the list pane from that URL
 * like any other inbound location.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceBrowserBackService {
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly location = inject(WorkspaceLocationAdapter);

  /**
   * The app URL a traversal leaving `surface` should land on instead, or `null` to follow history.
   *
   * The viewport is read live rather than from the compact signal: a guard can run in the same
   * frame as a breakpoint change, before `matchMedia` has delivered it to the page. A wide layout,
   * or a surface that is no longer the open Conversation, follows browser history.
   */
  traversalRedirect(surface: WorkspaceConversationSurface): string | null {
    const view = this.workspace.view();
    if (
      !matchesQuery(BELOW_MD_QUERY) ||
      view.pane !== 'conversation' ||
      view.accountId !== surface.accountId ||
      view.roomId !== surface.roomId
    ) {
      return null;
    }
    const resolved = resolveWorkspaceNavigation(
      { kind: 'list', origin: 'workspace-back' },
      view,
    );
    return resolved ? this.location.urlOf(resolved.destination) : null;
  }
}
