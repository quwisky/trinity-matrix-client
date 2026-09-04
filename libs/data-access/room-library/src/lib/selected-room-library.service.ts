import {
  DestroyRef,
  Injectable,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { defer, type Observable } from 'rxjs';
import {
  MatrixClientService,
  coalesce,
} from '@trinity/data-access/matrix-client';
import { type PreferenceCommandOutcome } from '@trinity/runtime/preferences';
import { AccountScopeService } from './account-scope.service';
import { InvitesService, type PendingInvite } from './invites.service';
import { RoomLibraryService, type RoomSummary } from './room-library.service';
import {
  ALL_SELECTED_PROJECTION_DOMAINS,
  SelectedAccountSourceRegistry,
  projectSelectedInvitations,
  projectSelectedRooms,
  projectSelectedSpaces,
  type SelectedProjectionDomain,
} from './selected-room-library-projection';
import { SpacesService, type SpaceSummary } from './spaces.service';

export type SelectedRoomLibraryMode = 'active' | 'mixed';

/** One atomic read of the effective Room Library selection and its projected rows. */
export interface SelectedRoomLibraryView {
  readonly accountIds: ReadonlySet<string>;
  readonly mode: SelectedRoomLibraryMode;
  readonly rooms: readonly RoomSummary[];
  readonly spaces: readonly SpaceSummary[];
  /** Joined space children indexed by the Account whose hierarchy declared them. */
  readonly spaceChildRoomIdsByAccount: ReadonlyMap<string, ReadonlySet<string>>;
  readonly invitations: readonly PendingInvite[];
}

function indexSpaceChildrenByAccount(
  spaces: readonly SpaceSummary[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const byAccount = new Map<string, Set<string>>();
  for (const space of spaces) {
    const childIds = byAccount.get(space.accountId) ?? new Set<string>();
    for (const roomId of space.childRoomIds) childIds.add(roomId);
    byAccount.set(space.accountId, childIds);
  }
  return byAccount;
}

/**
 * The public selected-Account Room Library boundary.
 *
 * It owns active-versus-mixed source choice, selected Account listener lifecycle, and the
 * Room, Space, and invitation projection policy behind one coherent read interface.
 */
@Injectable({ providedIn: 'root' })
export class SelectedRoomLibraryService {
  private readonly scope = inject(AccountScopeService);
  private readonly activeRooms = inject(RoomLibraryService);
  private readonly activeSpaces = inject(SpacesService);
  private readonly activeInvites = inject(InvitesService);
  private readonly matrix = inject(MatrixClientService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly pendingDomains = new Set<SelectedProjectionDomain>();
  private readonly sources = new SelectedAccountSourceRegistry(
    this.matrix,
    (domains) => this.scheduleProjection(domains),
  );
  private readonly projectionFlusher = coalesce(() => {
    const domains = new Set(this.pendingDomains);
    this.pendingDomains.clear();
    this.publishSelection(domains);
  });

  private readonly _view = signal<SelectedRoomLibraryView>({
    accountIds: this.scope.selected(),
    mode: 'active',
    rooms: this.activeRooms.rooms(),
    spaces: this.activeSpaces.spaces(),
    spaceChildRoomIdsByAccount: indexSpaceChildrenByAccount(
      this.activeSpaces.spaces(),
    ),
    invitations: this.activeInvites.pendingInvites(),
  });

  /**
   * Effective Account set, mode, and all three row kinds from one published generation.
   * A one-Account selection always reads the active projections directly and therefore
   * adds no selected-registry listeners to the single-Account path.
   */
  readonly view = this._view.asReadonly();

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.projectionFlusher.cancel();
      this.pendingDomains.clear();
      this.sources.release();
    });
    // Publish once before injection returns, then keep selection, live Account/client
    // replacement, Active Account ownership, and active projections current.
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

  private scheduleProjection(
    domains: ReadonlySet<SelectedProjectionDomain>,
  ): void {
    for (const domain of domains) this.pendingDomains.add(domain);
    this.projectionFlusher.schedule();
  }

  private publishSelection(
    requestedDomains: ReadonlySet<SelectedProjectionDomain> = ALL_SELECTED_PROJECTION_DOMAINS,
  ): void {
    const accountIds = this.scope.selected();
    const mode: SelectedRoomLibraryMode =
      accountIds.size > 1 ? 'mixed' : 'active';

    if (mode === 'active') {
      this.sources.reconcile(accountIds);
      this._view.set({
        accountIds,
        mode,
        rooms: this.activeRooms.rooms(),
        spaces: this.activeSpaces.spaces(),
        spaceChildRoomIdsByAccount: indexSpaceChildrenByAccount(
          this.activeSpaces.spaces(),
        ),
        invitations: this.activeInvites.pendingInvites(),
      });
      return;
    }

    const previous = untracked(this._view);
    const sourceChanged = this.sources.reconcile(accountIds);
    const selectionChanged =
      previous.mode !== mode || previous.accountIds !== accountIds;
    const domains =
      sourceChanged || selectionChanged
        ? ALL_SELECTED_PROJECTION_DOMAINS
        : requestedDomains;
    const sources = this.sources.current();
    const activeAccountId = this.matrix.activeUserId();
    const spaces = domains.has('spaces')
      ? projectSelectedSpaces(sources, activeAccountId)
      : {
          spaces: previous.spaces,
          childRoomIdsByAccount: previous.spaceChildRoomIdsByAccount,
        };

    this._view.set({
      accountIds,
      mode,
      rooms: domains.has('rooms')
        ? projectSelectedRooms(sources, activeAccountId)
        : previous.rooms,
      spaces: spaces.spaces,
      spaceChildRoomIdsByAccount: spaces.childRoomIdsByAccount,
      invitations: domains.has('invitations')
        ? projectSelectedInvitations(sources)
        : previous.invitations,
    });
  }
}
