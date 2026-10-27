import {
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { defer, Observable } from 'rxjs';
import {
  SESSION_ENGINE,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import { type PreferenceCommandOutcome } from '@trinity/runtime/preferences';
import { ownedProjection } from '@trinity/runtime/projection';
import { plainEqual } from '@trinity/util/matrix';
import { AccountScopeService } from './account-scope.service';
import { InvitesService, type PendingInvite } from './invites.service';
import {
  RoomLibraryService,
  type RoomLibrarySelectionAvailability,
  type RoomSummary,
} from './room-library.service';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';
import { RoomListStore } from './room-list-store';
import {
  type AccountSource,
  projectSelectedInvitations,
  projectSelectedRooms,
  projectSelectedSpaces,
} from './selected-room-library-projection';
import { SpaceLinkFeeds, linkKey } from './space-link-feeds';
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

const EMPTY_INDEX: ReadonlyMap<string, ReadonlySet<string>> = new Map();

/**
 * The public selected-Account Room Library boundary: active-versus-mixed source choice and
 * the merge of selected Accounts' {@link RoomListStore} rows into Room/Space/invitation
 * projections behind one read.
 */
@Injectable({ providedIn: 'root' })
export class SelectedRoomLibraryService {
  private readonly scope = inject(AccountScopeService);
  private readonly activeRooms = inject(RoomLibraryService);
  private readonly activeSpaces = inject(SpacesService);
  private readonly activeInvites = inject(InvitesService);
  private readonly store = inject(RoomListStore);
  private readonly session = inject(SessionStateService);
  private readonly links = new SpaceLinkFeeds(inject(ROOM_LIST_ENGINE));

  /** Idle until the first projection lifetime; released once the last one ends. */
  private readonly lifetime = signal<'idle' | 'connected' | 'released'>('idle');

  private readonly mixed = computed(
    () => this.scope.selected().size > 1 && this.lifetime() === 'connected',
  );

  /** Selected, live Accounts in a stable order, so duplicate fallback ownership is deterministic. */
  private readonly sources = computed((): readonly AccountSource[] => {
    // Read directly, not through `mixed`: a reconnect must re-open the links a release closed.
    const selected = this.scope.selected();
    if (selected.size < 2 || this.lifetime() !== 'connected') return [];
    return [...selected]
      .sort((a, b) => a.localeCompare(b))
      .flatMap((accountId) => {
        const generation = this.session.status(accountId)?.generation;
        return generation === undefined
          ? []
          : [{ accountId, generation, rows: this.store.rooms(accountId)() }];
      });
  });

  private readonly mixedRooms = computed(
    () => projectSelectedRooms(this.sources(), this.session.activeAccountId()),
    { equal: plainEqual },
  );

  private readonly mixedSpaces = computed(
    () => {
      const open = new Set<string>();
      const projection = projectSelectedSpaces(
        this.sources(),
        this.session.activeAccountId(),
        ({ accountId, generation }, spaceId) => {
          open.add(linkKey(accountId, generation, spaceId));
          return this.links.linksOf(accountId, generation, spaceId);
        },
      );
      // A space that left the view closes here; an Account that left closes on the session.
      untracked(() => this.links.close((feed) => !open.has(feed.key)));
      return projection;
    },
    { equal: plainEqual },
  );

  private readonly mixedChildIndex = computed(
    (): ReadonlyMap<string, ReadonlySet<string>> =>
      new Map(
        this.mixedSpaces().childRoomIdsByAccount.map(([accountId, ids]) => [
          accountId,
          new Set(ids),
        ]),
      ),
  );

  private readonly mixedInvitations = computed(
    () => projectSelectedInvitations(this.sources()),
    { equal: plainEqual },
  );

  private readonly activeChildIndex = computed(() =>
    indexSpaceChildrenByAccount(this.activeSpaces.spaces()),
  );

  /**
   * Effective Account set, mode, and all three row kinds from one read. A one-Account
   * selection reads the active projections directly and holds no selected space links.
   */
  readonly view = computed((): SelectedRoomLibraryView => {
    const accountIds = this.scope.selected();
    const lifetime = this.lifetime();
    const mode: SelectedRoomLibraryMode =
      accountIds.size > 1 ? 'mixed' : 'active';
    if (lifetime === 'released') {
      return {
        accountIds,
        mode,
        rooms: [],
        spaces: [],
        spaceChildRoomIdsByAccount: EMPTY_INDEX,
        invitations: [],
      };
    }
    if (!this.mixed()) {
      return {
        accountIds,
        mode: 'active',
        rooms: this.activeRooms.rooms(),
        spaces: this.activeSpaces.spaces(),
        spaceChildRoomIdsByAccount: this.activeChildIndex(),
        invitations: this.activeInvites.pendingInvites(),
      };
    }
    return {
      accountIds,
      mode,
      rooms: this.mixedRooms(),
      spaces: this.mixedSpaces().spaces,
      spaceChildRoomIdsByAccount: this.mixedChildIndex(),
      invitations: this.mixedInvitations(),
    };
  });

  constructor() {
    // Leaving the mixed view, or deselecting an Account, closes its links without a read.
    effect(() => {
      const selected = this.scope.selected();
      const mixed = this.mixed();
      untracked(() =>
        this.links.close((feed) => !mixed || !selected.has(feed.accountId)),
      );
    });
    // Closes the links of an Account that signed out or restarted, without a read.
    inject(SESSION_ENGINE)
      .session()
      .pipe(takeUntilDestroyed())
      .subscribe(() =>
        untracked(() =>
          this.links.close(
            (feed) =>
              this.session.status(feed.accountId)?.generation !==
              feed.generation,
          ),
        ),
      );
    inject(DestroyRef).onDestroy(() => this.links.close(() => true));
  }

  /** Selected-Account projection retained by the Room Library session lifetime. */
  runProjection(): Observable<void> {
    return ownedProjection(
      () => this.lifetime.set('connected'),
      () => {
        this.lifetime.set('released');
        this.links.close(() => true);
      },
    );
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
   * - `unavailable`: none holds it once that is settled, the Account is not live, or
   *   the id is not a Room id. A selected Account that is not live (failed to start)
   *   does not count as holding it: none of its Rooms can be listed either.
   *
   * A Space left, or only invited to, is not held; flows that open a Space they just joined
   * wait for the join first. The answer reads the live selection, session and room lists
   * directly, so it never waits for the mixed projection and re-runs when the shown Accounts'
   * memberships change.
   */
  spaceAvailability(
    accountId: string,
    spaceId: string,
  ): RoomLibrarySelectionAvailability {
    const live = new Set(this.session.accountIds());
    if (!live.has(accountId) || !spaceId.startsWith('!')) return 'unavailable';
    const selected = this.scope.selected();
    const shown =
      selected.size > 1 && selected.has(accountId)
        ? [...selected].filter((id) => live.has(id))
        : [accountId];
    const holds = (id: string): boolean => {
      const space = this.store.room(id, spaceId);
      return !!space?.isSpace && space.membership === 'join';
    };
    if (shown.some(holds)) return 'available';
    if (!this.session.status(accountId)?.serverSynced) return 'unconfirmed';
    return shown.some(
      (id) => id !== accountId && !this.session.status(id)?.roomsPrepared,
    )
      ? 'unconfirmed'
      : 'unavailable';
  }
}
