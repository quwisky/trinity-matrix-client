import { Location } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
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
import { BACKGROUND_NAVIGATION_INFO } from '@trinity/util/ui';
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
  /** The person did not make this navigation (a repair): their focus stays where it is. */
  readonly background?: boolean;
  /** A panel change inside the open Room (see `WorkspaceOpenOptions.withinRoom`). */
  readonly withinRoom?: boolean;
}

/** History-state key on a Conversation entry pushed straight over its list. */
const LIST_BELOW = 'trinityListBelow';

/** History-state key on a panel entry pushed over another entry of the same Room. */
const PANEL_BELOW = 'trinityPanelBelow';

/** How long a popped entry may take to settle before Back writes the list in place. */
const POP_SETTLE_MS = 3_000;

/** The only adapter between semantic Workspace state and Angular Router. */
@Injectable({ providedIn: 'root' })
export class WorkspaceLocationAdapter {
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly listBelowState = signal(this.readMark(LIST_BELOW));
  private readonly panelBelowState = signal(this.readMark(PANEL_BELOW));
  private pendingProjections = 0;

  /** The current history entry is a Conversation pushed straight over its list. */
  readonly listBelow = this.listBelowState.asReadonly();
  /** The current history entry is a panel pushed over another entry of its Room. */
  readonly panelBelow = this.panelBelowState.asReadonly();

  /**
   * A Router navigation is in flight, whoever started it: Workspace, or the person heading
   * for another page such as Settings. Workspace leaves the view alone meanwhile.
   */
  readonly navigating = computed(
    () => this.router.currentNavigation() !== null,
  );

  constructor() {
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        this.listBelowState.set(this.readMark(LIST_BELOW));
        this.panelBelowState.set(this.readMark(PANEL_BELOW));
      });
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
            ? this.popTo(destination, projection)
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
    const push = options.history === 'push';
    // A panel push, or any replace, that stays in the Room keeps the marks of the entry it
    // leaves or rewrites, so Back and a later close still find what lies below.
    const keepMarks =
      (!push || options.withinRoom === true) && this.inSameRoom(destination);
    const listBelow =
      push && options.overList === true
        ? this.rewriteListBelow(destination)
        : keepMarks &&
          destination.pane === 'conversation' &&
          this.readMark(LIST_BELOW);
    const panelBelow =
      keepMarks &&
      destination.panel !== null &&
      (push || this.readMark(PANEL_BELOW));
    return this.router.navigate([...projection.commands], {
      queryParams: { ...projection.queryParams },
      replaceUrl: options.history === 'replace',
      ...(listBelow || panelBelow
        ? {
            state: {
              ...(listBelow ? { [LIST_BELOW]: true } : {}),
              ...(panelBelow ? { [PANEL_BELOW]: true } : {}),
            },
          }
        : {}),
      ...(options.background ? { info: BACKGROUND_NAVIGATION_INFO } : {}),
    });
  }

  private inSameRoom(destination: WorkspaceDestination): boolean {
    const here = this.current(destination.accountId);
    const current = here.kind === 'workspace' ? here.parsed.destination : null;
    return (
      destination.roomId !== null &&
      current?.accountId === destination.accountId &&
      current.roomId === destination.roomId
    );
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
   * Pop the current entry and resolve once the Router has settled on the one below, popping on
   * only while the entry reached is marked as sitting on the destination's side (see
   * {@link marksMore}). When the entry reached is not the expected projection, or nothing
   * settles, write the projection in place.
   */
  private async popTo(
    destination: WorkspaceDestination,
    projection: ReturnType<typeof workspaceUrlOf>,
  ): Promise<boolean> {
    const target = this.urlOf(projection);
    for (;;) {
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
      if (!(event instanceof NavigationEnd)) break;
      if (this.router.url === target) return true;
      if (!this.marksMore(destination)) break;
    }
    const keepListBelow =
      destination.pane === 'conversation' && this.readMark(LIST_BELOW);
    return this.router.navigate([...projection.commands], {
      queryParams: { ...projection.queryParams },
      replaceUrl: true,
      ...(keepListBelow ? { state: { [LIST_BELOW]: true } } : {}),
    });
  }

  /**
   * Whether the entry a pop reached says the destination lies one more pop below it: one of
   * the Room's panels marked as pushed over the Room, or the Room itself marked as pushed over
   * the list the destination names. An unmarked entry ends the walk, so it never leaves the
   * Room's history.
   */
  private marksMore(destination: WorkspaceDestination): boolean {
    const here = this.current(destination.accountId);
    const landed = here.kind === 'workspace' ? here.parsed.destination : null;
    if (landed === null || landed.roomId !== destination.roomId) return false;
    if (landed.panel !== null) return this.readMark(PANEL_BELOW);
    return (
      landed.pane === 'conversation' &&
      destination.pane === 'list' &&
      this.readMark(LIST_BELOW)
    );
  }

  private urlOf(projection: ReturnType<typeof workspaceUrlOf>): string {
    return this.router.serializeUrl(
      this.router.createUrlTree([...projection.commands], {
        queryParams: { ...projection.queryParams },
      }),
    );
  }

  private readMark(key: typeof LIST_BELOW | typeof PANEL_BELOW): boolean {
    const state: unknown = this.location.getState();
    return (
      typeof state === 'object' &&
      state !== null &&
      (state as Record<string, unknown>)[key] === true
    );
  }
}
