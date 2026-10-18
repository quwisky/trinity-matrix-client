import {
  DestroyRef,
  type EffectRef,
  Injectable,
  Injector,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { defer, Observable } from 'rxjs';
import {
  MatrixClientService,
  coalesce,
} from '@trinity/data-access/matrix-client';
import { type PreferenceCommandOutcome } from '@trinity/runtime/preferences';
import { ownedProjection } from '@trinity/runtime/projection';
import { AccountScopeService } from './account-scope.service';
import { InvitesService, type PendingInvite } from './invites.service';
import {
  RoomLibraryService,
  type RoomLibrarySelectionAvailability,
  type RoomSummary,
} from './room-library.service';
import { isJoinedSpace } from './room-projection';
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
 * The public selected-Account Room Library boundary: active-versus-mixed source choice,
 * selected Account listener lifecycle and Room/Space/invitation projection behind one read.
 */
@Injectable({ providedIn: 'root' })
export class SelectedRoomLibraryService {
  private readonly injector = inject(Injector);
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
  private watcher: EffectRef | null = null;

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
    this.destroyRef.onDestroy(() => this.disconnect());
  }

  /** Cold selected-Account projection retained by the Room Library session lifetime. */
  runProjection(): Observable<void> {
    return ownedProjection(
      () => this.connect(),
      () => this.disconnect(),
    );
  }

  private connect(): void {
    if (this.watcher) return;
    this.watcher = effect(() => this.publishSelection(), {
      injector: this.injector,
    });
    this.publishSelection();
  }

  private disconnect(): void {
    if (!this.watcher) return;
    this.watcher.destroy();
    this.watcher = null;
    this.projectionFlusher.cancel();
    this.pendingDomains.clear();
    this.sources.release();
    const accountIds = this.scope.selected();
    this._view.set({
      accountIds,
      mode: accountIds.size > 1 ? 'mixed' : 'active',
      rooms: [],
      spaces: [],
      spaceChildRoomIdsByAccount: new Map(),
      invitations: [],
    });
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

  /**
   * Whether Workspace may keep a Space selected while acting as `accountId`.
   *
   * - `available`: the Account has joined the Space or, in the mixed view it is part of,
   *   another selected Account has. The Space is then listed (rail pill, sidebar children), so
   *   any selected Account may keep it while opening one of those Rooms.
   * - `unconfirmed`: none holds it yet, and either the Account itself has not completed a sync
   *   with its homeserver (cache replay only, offline, or still starting) or another selected
   *   Account has not loaded even its sync cache. Keep it, as an unsynced Room is kept. Another
   *   Account counts once it has replayed its cache: one with an unreachable homeserver lives
   *   on that cache, and waiting for its server would keep a Space it does not hold loading
   *   indefinitely.
   * - `unavailable`: none holds it once that is settled, the Account's client is not live, or
   *   the id is not a Room id. A selected Account whose client is not live (failed to start)
   *   does not count as holding it: none of its Rooms can be listed either.
   *
   * A Space left, or only invited to, is not held (see {@link isJoinedSpace}); flows that open
   * a Space they just joined wait for the join first. The answer comes from the live selection
   * and clients, so it never waits for a projection flush and an empty republish never reads as
   * "gone". It reads {@link view} only to re-run when the shown Accounts' Rooms or memberships
   * change.
   */
  spaceAvailability(
    accountId: string,
    spaceId: string,
  ): RoomLibrarySelectionAvailability {
    this._view();
    const live = new Set(this.matrix.accountIds());
    if (!live.has(accountId) || !spaceId.startsWith('!')) return 'unavailable';
    const selected = this.scope.selected();
    const shown =
      selected.size > 1 && selected.has(accountId)
        ? [...selected].filter((id) => live.has(id))
        : [accountId];
    const holds = (id: string): boolean => {
      const space = this.matrix.clientFor(id)?.getRoom(spaceId);
      return !!space && isJoinedSpace(space);
    };
    if (shown.some(holds)) return 'available';
    if (!this.matrix.serverSynced(accountId)) return 'unconfirmed';
    return shown.some(
      (id) => id !== accountId && !this.matrix.roomsPrepared(id),
    )
      ? 'unconfirmed'
      : 'unavailable';
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
        ? projectSelectedRooms(sources, activeAccountId, (accountId, roomId) =>
            this.sources.learnEncryption(accountId, roomId),
          )
        : previous.rooms,
      spaces: spaces.spaces,
      spaceChildRoomIdsByAccount: spaces.childRoomIdsByAccount,
      invitations: domains.has('invitations')
        ? projectSelectedInvitations(sources)
        : previous.invitations,
    });
  }
}
