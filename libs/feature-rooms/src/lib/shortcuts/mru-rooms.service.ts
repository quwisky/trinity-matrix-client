import { Injectable, signal } from '@angular/core';

/** How long (ms) after the last hop press before the landed room commits to the top. */
const HOP_IDLE_MS = 1200;

/** Cap the visit stack so a long session can't grow it without bound. */
const MAX_VISITS = 20;

/** Which way a hop moves through the frozen snapshot. */
export type HopDirection = 'back' | 'forward';

/**
 * The most-recently-**visited** room stack — where the user *was*, distinct from the
 * activity-recency the quick switcher and Recent view use. Session-scoped (in memory);
 * a visit-MRU is inherently a session concept, so it is not persisted across restarts.
 *
 * Powers the keyboard room-switching shortcuts:
 *
 *  - {@link record} keeps the stack, called for every user-driven room open.
 *  - {@link hop} cycles alt-tab style through a *frozen* snapshot: repeated presses walk
 *    deeper without reordering the stack, so the order stays stable while cycling. The
 *    landed room commits to the top when the user pauses ({@link HOP_IDLE_MS}) or opens a
 *    room another way (which calls {@link record}).
 *  - {@link nth} resolves Ctrl/Cmd+1…9 (the Nth most-recent room, skipping the current).
 */
@Injectable({ providedIn: 'root' })
export class MruRoomsService {
  private readonly _visited = signal<string[]>([]);
  /** The visit stack, most-recently-visited first. */
  readonly visited = this._visited.asReadonly();

  /** Snapshot of the stack taken when a hop cycle began, or null when not cycling. */
  private hopSnapshot: string[] | null = null;
  private hopIndex = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Record a user-driven visit to `id`: move it to the front of the stack (deduped,
   * capped) and end any hop cycle in progress — the explicit open is the commit.
   */
  record(id: string): void {
    this.endHop();
    this._visited.update((visited) =>
      [id, ...visited.filter((existing) => existing !== id)].slice(
        0,
        MAX_VISITS,
      ),
    );
  }

  /**
   * Step through the visit stack alt-tab style and return the room to open, or null when
   * there is nowhere to hop. `currentId` is the room open now (forced to the front of the
   * snapshot so a hop always starts from "here"); `knownIds` is the set of rooms that
   * still exist, so a room since left/forgotten is skipped rather than opened.
   *
   * The first hop of a cycle snapshots the stack; subsequent hops walk that frozen order
   * (clamped at both ends) without reordering it. Each press re-arms the idle commit.
   */
  hop(
    direction: HopDirection,
    currentId: string | null,
    knownIds: ReadonlySet<string>,
  ): string | null {
    if (!this.hopSnapshot) {
      const ordered = currentId
        ? [currentId, ...this._visited().filter((id) => id !== currentId)]
        : [...this._visited()];
      this.hopSnapshot = ordered.filter((id) => knownIds.has(id));
      this.hopIndex = 0;
    }
    const snapshot = this.hopSnapshot;
    if (snapshot.length < 2) {
      this.endHop(); // nothing to cycle through
      return null;
    }
    const next = this.hopIndex + (direction === 'back' ? 1 : -1);
    this.hopIndex = Math.max(0, Math.min(next, snapshot.length - 1));
    this.armIdleCommit();
    return snapshot[this.hopIndex];
  }

  /**
   * The Nth most-recently-visited room, skipping the one open now — so Ctrl/Cmd+1 is the
   * previous room. Returns null when the stack is too short. `currentId` is excluded so
   * the numbering matches what a user would count ("1 = the last place I was").
   */
  nth(n: number, currentId: string | null): string | null {
    const others = this._visited().filter((id) => id !== currentId);
    return others[n - 1] ?? null;
  }

  /** Whether a hop cycle is currently in progress (exposed for tests / guards). */
  get hopping(): boolean {
    return this.hopSnapshot !== null;
  }

  /** Arm (or re-arm) the timer that commits the landed room once hopping pauses. */
  private armIdleCommit(): void {
    this.clearTimer();
    this.idleTimer = setTimeout(() => {
      const landed = this.hopSnapshot?.[this.hopIndex] ?? null;
      // record() clears the session, then moves the landed room to the front.
      if (landed) {
        this.record(landed);
      } else {
        this.endHop();
      }
    }, HOP_IDLE_MS);
  }

  private endHop(): void {
    this.clearTimer();
    this.hopSnapshot = null;
    this.hopIndex = 0;
  }

  private clearTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
