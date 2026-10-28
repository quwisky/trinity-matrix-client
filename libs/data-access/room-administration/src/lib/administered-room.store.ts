import {
  Injectable,
  type Signal,
  type WritableSignal,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { Observable, Subscription } from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import type {
  AdministeredRoom,
  RoomMembers,
} from './room-administration-engine';
import { ROOM_ADMINISTRATION_ENGINE } from './room-administration-engine.token';

interface Entry<T> {
  readonly accountId: string;
  readonly generation: number;
  readonly value: WritableSignal<T | null>;
  readonly subscription: Subscription;
}

/**
 * Synchronous, reactive reads of {@link ROOM_ADMINISTRATION_ENGINE} per account and room.
 * The first read of a key subscribes, untracked, so a read inside a `computed` is safe;
 * the subscription lasts until the account signs out or gets a new session generation.
 */
@Injectable({ providedIn: 'root' })
export class AdministeredRoomStore {
  private readonly engine = inject(ROOM_ADMINISTRATION_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly rooms = new Map<string, Entry<AdministeredRoom>>();
  private readonly memberLists = new Map<string, Entry<RoomMembers>>();
  private readonly generations = new Map<string, Signal<number | null>>();

  constructor() {
    // Releases keys nobody reads again; a read replaces a stale key itself.
    effect(() => {
      this.session.snapshot();
      untracked(() => {
        this.releaseStale(this.rooms);
        this.releaseStale(this.memberLists);
      });
    });
  }

  /** The room as `accountId` sees it; null while the account is not live or does not know it. */
  room(accountId: string, roomId: string): AdministeredRoom | null {
    return this.read(this.rooms, accountId, roomId, () =>
      this.engine.room(accountId, roomId),
    );
  }

  /** The room's members as `accountId` sees them; null as for {@link room}. */
  members(accountId: string, roomId: string): RoomMembers | null {
    return this.read(this.memberLists, accountId, roomId, () =>
      this.engine.members(accountId, roomId),
    );
  }

  private read<T>(
    entries: Map<string, Entry<T>>,
    accountId: string,
    roomId: string,
    source: () => Observable<T | null>,
  ): T | null {
    const generation = this.generationOf(accountId);
    if (generation === null) return null;
    const key = `${accountId}\u001f${roomId}`;
    let entry = entries.get(key);
    if (entry?.generation !== generation) {
      entry = untracked(() => {
        this.release(entries, key);
        const value = signal<T | null>(null);
        const subscription = source().subscribe({
          next: (next) => value.set(next),
          error: () => value.set(null),
        });
        const created = { accountId, generation, value, subscription };
        entries.set(key, created);
        return created;
      });
    }
    return entry.value();
  }

  private generationOf(accountId: string): number | null {
    let generation = this.generations.get(accountId);
    if (!generation) {
      generation = computed(
        () => this.session.status(accountId)?.generation ?? null,
      );
      this.generations.set(accountId, generation);
    }
    return generation();
  }

  private releaseStale<T>(entries: Map<string, Entry<T>>): void {
    for (const [key, entry] of entries) {
      if (this.generationOf(entry.accountId) !== entry.generation) {
        this.release(entries, key);
      }
    }
  }

  private release<T>(entries: Map<string, Entry<T>>, key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    entry.subscription.unsubscribe();
    entry.value.set(null);
  }
}
