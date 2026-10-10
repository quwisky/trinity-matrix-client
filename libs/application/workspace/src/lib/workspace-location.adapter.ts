import { Location } from '@angular/common';
import { Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  PRIMARY_OUTLET,
  Router,
  convertToParamMap,
} from '@angular/router';
import {
  Observable,
  defer,
  filter,
  firstValueFrom,
  from,
  map,
  race,
  startWith,
  timer,
} from 'rxjs';
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
  readonly history: 'push' | 'replace' | 'back';
  readonly overList?: boolean;
  readonly eventId?: string | null;
}

/** History-state key on a Conversation entry pushed straight over its list (#1113). */
const LIST_BELOW = 'trinityListBelow';

/** How long a popped entry may take to settle before Back writes the list in place. */
const POP_SETTLE_MS = 3_000;

/** The only adapter between semantic Workspace state and Angular Router. */
@Injectable({ providedIn: 'root' })
export class WorkspaceLocationAdapter {
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly listBelowState = signal(this.readListBelow());
  private pendingProjections = 0;

  /** The current history entry is a Conversation pushed straight over its list. */
  readonly listBelow = this.listBelowState.asReadonly();

  constructor() {
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.listBelowState.set(this.readListBelow()));
  }

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
        navigation =
          options.history === 'back'
            ? this.popTo(projection)
            : this.write(projection, destination, options);
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

  /** Push or replace the projection; over the list, first rewrite the entry it leaves. */
  private write(
    projection: ReturnType<typeof workspaceUrlOf>,
    destination: WorkspaceDestination,
    options: WorkspaceLocationProjection,
  ): Promise<boolean> {
    const overList =
      options.history === 'push' &&
      options.overList === true &&
      this.rewriteListBelow(destination);
    return this.router.navigate([...projection.commands], {
      queryParams: { ...projection.queryParams },
      replaceUrl: options.history === 'replace',
      ...(overList ? { state: { [LIST_BELOW]: true } } : {}),
    });
  }

  /**
   * Point the list entry being left at the list view Back returns to, with this Room still
   * selected, so popping the Conversation lands exactly there. Only a Workspace list entry
   * qualifies; anything else stays untouched and the Conversation goes unmarked.
   */
  private rewriteListBelow(destination: WorkspaceDestination): boolean {
    const here = this.current(destination.accountId);
    if (here.kind !== 'workspace' || here.parsed.destination?.pane !== 'list')
      return false;
    this.location.replaceState(
      this.urlOf(workspaceUrlOf({ ...destination, pane: 'list' })),
      '',
      this.location.getState(),
    );
    return true;
  }

  /**
   * Pop the current entry and resolve once the Router has settled on the one below. When
   * that is not the expected projection, or nothing settles, write the projection in place.
   */
  private async popTo(
    projection: ReturnType<typeof workspaceUrlOf>,
  ): Promise<boolean> {
    const settled = firstValueFrom(
      race(
        this.router.events.pipe(
          filter(
            (event) =>
              event instanceof NavigationEnd ||
              event instanceof NavigationCancel ||
              event instanceof NavigationError ||
              event instanceof NavigationSkipped,
          ),
        ),
        timer(POP_SETTLE_MS).pipe(map(() => null)),
      ),
    );
    this.location.back();
    const event = await settled;
    if (
      event instanceof NavigationEnd &&
      this.router.url === this.urlOf(projection)
    )
      return true;
    return this.router.navigate([...projection.commands], {
      queryParams: { ...projection.queryParams },
      replaceUrl: true,
    });
  }

  private urlOf(projection: ReturnType<typeof workspaceUrlOf>): string {
    return this.router.serializeUrl(
      this.router.createUrlTree([...projection.commands], {
        queryParams: { ...projection.queryParams },
      }),
    );
  }

  private readListBelow(): boolean {
    const state: unknown = this.location.getState();
    return (
      typeof state === 'object' &&
      state !== null &&
      (state as Record<string, unknown>)[LIST_BELOW] === true
    );
  }
}
