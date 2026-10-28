import {
  Injectable,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import {
  type Observable,
  combineLatest,
  defer,
  map,
  switchMap,
  tap,
} from 'rxjs';
import { plainEqual } from '@trinity/util/matrix';
import type {
  AccountDataSnapshot,
  ExpressionEngine,
  PackRoomSnapshot,
} from './expression-engine';
import {
  IMAGE_PACK_ROOMS_EVENT_TYPE,
  LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE,
} from './image-pack.model';

export interface ImagePackSelectionSnapshot {
  readonly present: boolean;
  readonly content: unknown;
}

export const OPTIMISTIC_TTL_MS = 30_000;

interface StoredSelection {
  readonly snapshot: ImagePackSelectionSnapshot;
  readonly expiresAt: number;
}

/** Shares the newest confirmed MSC2545 account data between management and picker projections. */
@Injectable({ providedIn: 'root' })
export class ImagePackSelectionStore {
  // One signal per account, created on first access, so a reader re-runs only for its own
  // account's selection.
  private readonly selections = new Map<
    string,
    WritableSignal<StoredSelection | null>
  >();

  private selection(accountId: string): WritableSignal<StoredSelection | null> {
    let selection = this.selections.get(accountId);
    if (!selection) {
      selection = signal<StoredSelection | null>(null);
      this.selections.set(accountId, selection);
    }
    return selection;
  }

  get(accountId: string): ImagePackSelectionSnapshot | null {
    const stored = this.selection(accountId)();
    return stored && stored.expiresAt > Date.now() ? stored.snapshot : null;
  }

  set(accountId: string, snapshot: ImagePackSelectionSnapshot): void {
    this.selection(accountId).set({
      snapshot,
      expiresAt: Date.now() + OPTIMISTIC_TTL_MS,
    });
  }

  /** The synced copy is authoritative once its account-data echo arrives. */
  clear(accountId: string): void {
    this.selections.get(accountId)?.set(null);
  }
}

/** Account data and the pack rooms read with it. */
export interface PackSources {
  readonly data: AccountDataSnapshot;
  readonly rooms: readonly PackRoomSnapshot[];
}

/** The selection in effect: a fresh confirmed write, else stable account data, else the legacy type. */
export function selectedPackRooms(
  data: AccountDataSnapshot,
  confirmed: ImagePackSelectionSnapshot | null,
): { readonly content: unknown; readonly legacy: boolean } {
  const stable = data[IMAGE_PACK_ROOMS_EVENT_TYPE] ?? null;
  if (confirmed?.present ?? stable !== null) {
    return { content: confirmed ? confirmed.content : stable, legacy: false };
  }
  return {
    content: data[LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE] ?? null,
    legacy: true,
  };
}

/** The room ids a selection references. */
export function selectedRoomIds(content: unknown): string[] {
  if (typeof content !== 'object' || content === null) return [];
  const rooms = (content as Record<string, unknown>)['rooms'];
  return typeof rooms === 'object' && rooms !== null && !Array.isArray(rooms)
    ? Object.keys(rooms)
    : [];
}

/**
 * `types` of `accountId`'s account data with the rooms its pack selection references plus
 * `extraRoomIds()`, re-read whenever `refresh` emits. A change to the synced selection is the
 * echo of a write, so it clears the account's confirmed copy in `store`.
 */
export function packSources(
  engine: ExpressionEngine,
  store: ImagePackSelectionStore,
  accountId: string,
  types: readonly string[],
  refresh: Observable<unknown>,
  extraRoomIds: () => readonly string[] = () => [],
): Observable<PackSources> {
  return defer(() => {
    let synced: { readonly content: unknown } | null = null;
    return combineLatest([
      engine.accountData(accountId, types).pipe(
        tap((data) => {
          const content = data[IMAGE_PACK_ROOMS_EVENT_TYPE] ?? null;
          if (synced && !plainEqual(synced.content, content)) {
            store.clear(accountId);
          }
          synced = { content };
        }),
      ),
      refresh,
    ]).pipe(
      switchMap(([data]) => {
        const { content } = selectedPackRooms(
          data,
          untracked(() => store.get(accountId)),
        );
        const roomIds = [
          ...new Set([...selectedRoomIds(content), ...extraRoomIds()]),
        ];
        return engine
          .packRooms(accountId, roomIds)
          .pipe(map((rooms) => ({ data, rooms })));
      }),
    );
  });
}
