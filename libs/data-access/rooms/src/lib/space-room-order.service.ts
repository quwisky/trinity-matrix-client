import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import {
  DEFAULT_ROOM_SORT,
  TRINITY_ROOM_SORTS,
  isRoomSortMode,
  type RoomSortMode,
} from './room-projection';

/**
 * Two keys per account, each suffixed with the user id. Neither prefix is a prefix of the
 * other, so the two namespaces cannot alias however the suffix is later extended.
 */
const DEFAULT_PREFIX = 'trinity.spaces.order.default.';
const OVERRIDES_PREFIX = 'trinity.spaces.order.overrides.';

/** One account's stored ordering: its default, plus the spaces that override it. */
interface AccountOrder {
  readonly fallback: RoomSortMode;
  readonly bySpace: Readonly<Record<string, RoomSortMode>>;
}

/** Which half of an account's record a write touched — only that key is re-serialised. */
type OrderKey = 'default' | 'overrides';

/** A single edit, replayable onto whatever the stored value turns out to be. */
type Change = (order: AccountOrder) => AccountOrder;

const EMPTY: AccountOrder = { fallback: DEFAULT_ROOM_SORT, bySpace: {} };

/**
 * How rooms are ordered inside a space: a per-account default plus per-space overrides.
 *
 * **Per account, device-scoped.** Unlike the other `trinity.*` preferences, both keys are
 * suffixed with the user id, so two accounts on one device keep separate orderings. Nothing is
 * written to Matrix account data — the ordering does not follow the account to another device.
 *
 * **Resolution: a space's own override wins, otherwise the _active_ account's default** — not
 * the default of whichever account "owns" the space. While mixing, one space's list can hold
 * children from several accounts, and the mixed projection picks a space's `accountId` by
 * preferring the active account, so "the owner" changes as you switch. The active account is
 * the one you are acting as and the one whose default Settings shows you. A corollary: an
 * override set as `@me` is invisible to `@alt` even for a space both have joined, which is
 * intended — it is that account's view preference.
 *
 * Overrides for spaces you have **left are deliberately not pruned**, for the same reason
 * {@link AccountScopeService} keeps stale account ids: the space list is sync-derived and
 * momentarily empty on a cold start and on every account switch, so pruning against it would
 * discard a pick for a space that simply had not synced yet. The map is bounded by the number
 * of spaces the user has ever re-ordered.
 */
@Injectable({ providedIn: 'root' })
export class SpaceRoomOrderService {
  private readonly matrix = inject(MatrixClientService);

  /** Hydrated preferences per account id; an account absent here reads as all-defaults. */
  private readonly byAccount = signal<ReadonlyMap<string, AccountOrder>>(
    new Map(),
  );

  /** Accounts whose read is in progress, so the hydrate effect never reads twice at once. */
  private readonly reading = new Set<string>();

  /** Accounts whose stored value has arrived — the ones a write may safely persist. */
  private readonly loaded = new Set<string>();

  /**
   * Edits made before an account's stored value arrived, in order, to be replayed onto it.
   *
   * A read is async, so a choice made while one is in flight is applied to a record derived
   * from all-defaults. Persisting *that* would drop every preference already on disk, and
   * merging the two records afterwards cannot express a {@link clearForSpace} (an absent key
   * is indistinguishable from one the merge should restore). Keeping the edits themselves
   * sidesteps both: replaying them onto the stored value yields exactly what the user asked
   * for, whichever edits they were.
   */
  private readonly pending = new Map<string, Change[]>();

  /** The orderings to offer in the UI (a plain field, so templates can `@for` over it). */
  readonly modes = TRINITY_ROOM_SORTS;

  /** The active account's default — what a space with no override of its own uses. */
  readonly defaultMode = computed<RoomSortMode>(
    () => this.activeOrder().fallback,
  );

  constructor() {
    // Hydrate each signed-in account as it appears. The read is async, so it cannot happen
    // inside effectiveFor()'s caller. Keyed on accountIds rather than activeUserId so an
    // account is warm *before* you switch to it — otherwise a space pinned to "Space order"
    // would paint in recency order and then visibly jump.
    effect(() => {
      for (const userId of this.matrix.accountIds()) {
        void this.hydrate(userId);
      }
    });
  }

  /**
   * Hydrate whatever accounts are already known. Wired as an app initializer, whose real job
   * is to *construct* this service so the effect above is live for the whole session — at that
   * point the persisted session usually has not been restored yet, so there is nothing to read.
   */
  async init(): Promise<void> {
    await Promise.all(this.matrix.accountIds().map((id) => this.hydrate(id)));
  }

  /**
   * The ordering a space's list should use. Reads signals, so a caller inside a `computed`
   * stays live to both a preference change and an account switch.
   */
  effectiveFor(spaceId: string | null): RoomSortMode {
    const order = this.activeOrder();
    return (spaceId ? order.bySpace[spaceId] : undefined) ?? order.fallback;
  }

  /** A space's explicit override, or `null` when it follows the account default. */
  overrideFor(spaceId: string | null): RoomSortMode | null {
    return (spaceId ? this.activeOrder().bySpace[spaceId] : undefined) ?? null;
  }

  /** Change and persist the active account's default (the Settings dropdown). */
  setDefault(mode: RoomSortMode): void {
    this.write('default', (order) => ({ ...order, fallback: mode }));
  }

  /** Pin one space to an ordering of its own (the sidebar header menu). */
  setForSpace(spaceId: string, mode: RoomSortMode): void {
    this.write('overrides', (order) => ({
      ...order,
      bySpace: { ...order.bySpace, [spaceId]: mode },
    }));
  }

  /**
   * Drop a space's override so it follows the account default again. Deleting the entry rather
   * than storing whatever the default happens to be right now is what makes "Use my default"
   * keep tracking a *later* change to that default.
   */
  clearForSpace(spaceId: string): void {
    this.write('overrides', (order) => {
      const bySpace = { ...order.bySpace };
      delete bySpace[spaceId];
      return { ...order, bySpace };
    });
  }

  /** The active account's record, or all-defaults when it has none yet. */
  private activeOrder(): AccountOrder {
    const userId = this.matrix.activeUserId();
    return (userId ? this.byAccount().get(userId) : undefined) ?? EMPTY;
  }

  /** Apply `change` to the active account's record, then persist or queue it. */
  private write(key: OrderKey, change: Change): void {
    const userId = this.matrix.activeUserId();
    if (!userId) {
      return; // signed out mid-interaction: nothing to key the preference to
    }
    const next = change(this.byAccount().get(userId) ?? EMPTY);
    const map = new Map(this.byAccount());
    map.set(userId, next);
    this.byAccount.set(map);

    if (!this.loaded.has(userId)) {
      // `next` was derived from all-defaults, so writing it now would erase whatever is on
      // disk. Hold the edit instead; {@link hydrate} replays it onto the stored value and
      // persists the result.
      this.pending.set(userId, [...(this.pending.get(userId) ?? []), change]);
      return;
    }
    persistHalf(userId, key, next);
  }

  /** Read one account's stored value, replay anything queued onto it, and adopt the result. */
  private async hydrate(userId: string): Promise<void> {
    if (this.reading.has(userId) || this.loaded.has(userId)) {
      return;
    }
    this.reading.add(userId);
    const stored = await readAccountOrder(userId);
    this.reading.delete(userId);

    if (!stored) {
      // The read FAILED — distinct from finding nothing stored. Leave the account unloaded
      // so a later sign-in retries, and keep any queued edits queued: persisting them now
      // would write defaults over preferences we merely could not read. The cost is that a
      // choice made under unreadable storage lasts only for the session.
      return;
    }

    const queued = this.pending.get(userId) ?? [];
    const merged = queued.reduce((order, change) => change(order), stored);
    this.pending.delete(userId);
    this.loaded.add(userId);

    const map = new Map(this.byAccount());
    map.set(userId, merged);
    this.byAccount.set(map);

    // Anything the user changed while the read was in flight never reached storage.
    for (const key of queued.length
      ? (['default', 'overrides'] as const)
      : []) {
      persistHalf(userId, key, merged);
    }
  }
}

/**
 * Both stored keys for one account, each validated, or `null` when storage could not be read
 * at all. The distinction matters: "nothing stored" is a legitimate all-defaults answer that a
 * write may build on, whereas a failed read leaves the account's real preferences unknown.
 */
async function readAccountOrder(userId: string): Promise<AccountOrder | null> {
  try {
    const [fallback, overrides] = await Promise.all([
      Preferences.get({ key: DEFAULT_PREFIX + userId }),
      Preferences.get({ key: OVERRIDES_PREFIX + userId }),
    ]);
    return {
      fallback: isRoomSortMode(fallback.value)
        ? fallback.value
        : DEFAULT_ROOM_SORT,
      bySpace: parseOverrides(overrides.value),
    };
  } catch {
    return null; // storage unavailable → defaults for the session, and no write over it
  }
}

/** Write back one half of an account's record. */
function persistHalf(userId: string, key: OrderKey, order: AccountOrder): void {
  persist(
    key === 'default' ? DEFAULT_PREFIX + userId : OVERRIDES_PREFIX + userId,
    key === 'default' ? order.fallback : JSON.stringify(order.bySpace),
  );
}

/** `{ [spaceId]: mode }`, dropping any entry naming a mode we no longer ship. */
function parseOverrides(raw: string | null): Record<string, RoomSortMode> {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const overrides: Record<string, RoomSortMode> = {};
    for (const [spaceId, mode] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof mode === 'string' && isRoomSortMode(mode)) {
        overrides[spaceId] = mode;
      }
    }
    return overrides;
  } catch {
    return {}; // corrupt JSON → no overrides, rather than a broken sidebar
  }
}

function persist(key: string, value: string): void {
  void Preferences.set({ key, value }).catch(() => undefined);
}
