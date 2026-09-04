import { Injectable, effect, inject, signal } from '@angular/core';
import { defer, type Observable } from 'rxjs';
import { type PreferenceCommandOutcome } from '@trinity/runtime/preferences';
import { AccountScopeService } from './account-scope.service';
import { InvitesService, type PendingInvite } from './invites.service';
import { MixedInvitesService } from './mixed-invites.service';
import { MixedRoomsService } from './mixed-rooms.service';
import { MixedSpacesService } from './mixed-spaces.service';
import { RoomLibraryService, type RoomSummary } from './room-library.service';
import { SpacesService, type SpaceSummary } from './spaces.service';

export type SelectedRoomLibraryMode = 'active' | 'mixed';

/** One atomic read of the effective Room Library selection and its projected rows. */
export interface SelectedRoomLibraryView {
  readonly accountIds: ReadonlySet<string>;
  readonly mode: SelectedRoomLibraryMode;
  readonly rooms: readonly RoomSummary[];
  readonly spaces: readonly SpaceSummary[];
  readonly invitations: readonly PendingInvite[];
}

/**
 * The public selected-Account Room Library boundary.
 *
 * It owns active-versus-mixed source choice and drives the legacy mixed projections while
 * the expand-migrate-contract sequence moves their remaining callers behind this view.
 */
@Injectable({ providedIn: 'root' })
export class SelectedRoomLibraryService {
  private readonly scope = inject(AccountScopeService);
  private readonly activeRooms = inject(RoomLibraryService);
  private readonly activeSpaces = inject(SpacesService);
  private readonly activeInvites = inject(InvitesService);
  private readonly mixedRooms = inject(MixedRoomsService);
  private readonly mixedSpaces = inject(MixedSpacesService);
  private readonly mixedInvites = inject(MixedInvitesService);

  private readonly _view = signal<SelectedRoomLibraryView>({
    accountIds: this.scope.selected(),
    mode: 'active',
    rooms: this.activeRooms.rooms(),
    spaces: this.activeSpaces.spaces(),
    invitations: this.activeInvites.pendingInvites(),
  });

  /**
   * Effective Account set, mode, and all three row kinds from one published generation.
   * A one-Account selection always reads the active projections directly; the intentionally
   * empty legacy mixed signals can therefore never blank the single-Account view.
   */
  readonly view = this._view.asReadonly();

  constructor() {
    // Publish once before injection returns, then keep the whole record current. The mixed
    // projectors rebuild synchronously when their Account generation changes, so no reader
    // can observe new Account ids paired with rows from the preceding generation.
    this.publishSelection();
    effect(() => this.publishSelection());
  }

  /** Persist one Account's inclusion; failed writes leave the published view unchanged. */
  setAccountSelected(
    accountId: string,
    selection: 'included' | 'excluded',
  ): Observable<PreferenceCommandOutcome> {
    return defer(() =>
      this.scope.setSelected(accountId, selection === 'included'),
    );
  }

  /** Toggle one Account's inclusion through the same cold finite preference command. */
  toggleAccount(accountId: string): Observable<PreferenceCommandOutcome> {
    return defer(() => this.scope.toggle(accountId));
  }

  private publishSelection(): void {
    const accountIds = this.scope.selected();
    const mode: SelectedRoomLibraryMode =
      accountIds.size > 1 ? 'mixed' : 'active';

    this.mixedRooms.setAccounts(accountIds);
    this.mixedSpaces.setAccounts(accountIds);
    this.mixedInvites.setAccounts(accountIds);

    this._view.set(
      mode === 'mixed'
        ? {
            accountIds,
            mode,
            rooms: this.mixedRooms.rooms(),
            spaces: this.mixedSpaces.spaces(),
            invitations: this.mixedInvites.invites(),
          }
        : {
            accountIds,
            mode,
            rooms: this.activeRooms.rooms(),
            spaces: this.activeSpaces.spaces(),
            invitations: this.activeInvites.pendingInvites(),
          },
    );
  }
}
