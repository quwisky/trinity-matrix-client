import { Injectable, inject } from '@angular/core';
import {
  NEVER,
  Observable,
  catchError,
  concat,
  finalize,
  map,
  of,
  switchMap,
  tap,
} from 'rxjs';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import { InvitesService } from './invites.service';
import { RoomLibraryService } from './room-library.service';
import { SelectedRoomLibraryService } from './selected-room-library.service';
import { SpaceChildrenService } from './space-children.service';
import { SpacesService } from './spaces.service';

export type RoomLibraryLifetimeEvent =
  | { readonly kind: 'prepared' }
  | {
      readonly kind: 'blocked';
      readonly diagnostic: {
        readonly code: 'room-library-projection-preparation-failed';
      };
    };

/** The Room Library projections required before Workspace restores a destination. */
@Injectable({ providedIn: 'root' })
export class RoomLibraryLifetime {
  private readonly projections = inject(ProjectionRuntime);
  private readonly rooms = inject(RoomLibraryService);
  private readonly spaces = inject(SpacesService);
  private readonly invitations = inject(InvitesService);
  private readonly hierarchy = inject(SpaceChildrenService);
  private readonly selected = inject(SelectedRoomLibraryService);

  /** Prepare once, emit one typed result, and retain ownership until unsubscribe. */
  run(): Observable<RoomLibraryLifetimeEvent> {
    return of(void 0).pipe(
      tap(() => this.connect()),
      switchMap(() => this.projections.waitFor({ kind: 'active-account' })),
      map(() => ({ kind: 'prepared' }) as const),
      catchError(() =>
        of({
          kind: 'blocked',
          diagnostic: {
            code: 'room-library-projection-preparation-failed',
          },
        } as const),
      ),
      switchMap((event) =>
        event.kind === 'prepared' ? concat(of(event), NEVER) : of(event),
      ),
      finalize(() => this.disconnect()),
    );
  }

  private connect(): void {
    this.rooms.connect();
    this.spaces.connect();
    this.invitations.connect();
    this.hierarchy.connect();
    this.selected.connect();
  }

  private disconnect(): void {
    this.selected.disconnect();
    this.hierarchy.disconnect();
    this.invitations.disconnect();
    this.spaces.disconnect();
    this.rooms.disconnect();
  }
}
