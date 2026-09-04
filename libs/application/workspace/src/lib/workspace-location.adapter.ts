import { Injectable, inject } from '@angular/core';
import {
  NavigationEnd,
  PRIMARY_OUTLET,
  Router,
  convertToParamMap,
} from '@angular/router';
import { Observable, defer, filter, from, map, startWith } from 'rxjs';
import type { WorkspaceDestination } from './workspace.models';
import {
  parseWorkspaceUrl,
  type ParsedWorkspaceUrl,
  workspaceUrlOf,
} from './workspace-url';

export type WorkspaceLocation =
  | { readonly kind: 'workspace'; readonly parsed: ParsedWorkspaceUrl }
  | { readonly kind: 'outside' };

interface WorkspaceLocationProjection {
  readonly history: 'push' | 'replace';
  readonly eventId?: string | null;
}

/** The only adapter between semantic Workspace state and Angular Router. */
@Injectable({ providedIn: 'root' })
export class WorkspaceLocationAdapter {
  private readonly router = inject(Router);
  private pendingProjections = 0;

  get projecting(): boolean {
    return this.pendingProjections > 0;
  }

  changes(activeAccountId: () => string | null): Observable<WorkspaceLocation> {
    return this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      startWith(null),
      map(() => this.current(activeAccountId())),
    );
  }

  current(activeAccountId: string | null): WorkspaceLocation {
    const tree = this.router.parseUrl(this.router.url);
    const segments = tree.root.children[PRIMARY_OUTLET]?.segments ?? [];
    if (
      segments.length < 1 ||
      segments.length > 2 ||
      segments[0]?.path !== 'rooms'
    ) {
      return { kind: 'outside' };
    }
    const roomId = segments[1]?.path;
    return {
      kind: 'workspace',
      parsed: parseWorkspaceUrl(
        convertToParamMap(roomId ? { roomId } : {}),
        tree.queryParamMap,
        activeAccountId,
      ),
    };
  }

  project(
    destination: WorkspaceDestination,
    options: WorkspaceLocationProjection,
  ): Observable<boolean> {
    const projection = workspaceUrlOf(destination, options.eventId);
    return defer(() => {
      this.pendingProjections += 1;
      let navigation: Promise<boolean>;
      try {
        navigation = this.router.navigate([...projection.commands], {
          queryParams: { ...projection.queryParams },
          replaceUrl: options.history === 'replace',
        });
      } catch (error) {
        this.pendingProjections -= 1;
        throw error;
      }
      void navigation.then(
        () => {
          this.pendingProjections -= 1;
        },
        () => {
          this.pendingProjections -= 1;
        },
      );
      return from(navigation);
    });
  }
}
