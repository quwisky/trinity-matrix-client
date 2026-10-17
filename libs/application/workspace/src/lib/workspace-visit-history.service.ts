import { Injectable, signal } from '@angular/core';
import { type WorkspaceRoomIdentity } from './workspace-navigation.models';

/** How long (ms) after the last hop press before the landed room commits to the top. */
const HOP_IDLE_MS = 1200;

/** Cap the visit stack so a long session can't grow it without bound. */
const MAX_VISITS = 20;

/** Which way a hop moves through the frozen snapshot. */
export type HopDirection = 'back' | 'forward';

function sameRoom(
  left: WorkspaceRoomIdentity,
  right: WorkspaceRoomIdentity,
): boolean {
  return left.accountId === right.accountId && left.roomId === right.roomId;
}

/**
 * The most-recently-**visited** Account-and-Room stack: where the user *was*, distinct from the
 * activity recency the quick switcher and Recent view use. In memory and session-scoped.
 *
 * Powers the keyboard room-switching shortcuts: {@link record} runs for every user-driven room
 * open; {@link hop} cycles alt-tab style through a frozen snapshot, so the order stays stable
 * while cycling; {@link nth} resolves Ctrl/Cmd+1…9.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceVisitHistoryService {
  private readonly _visited = signal<WorkspaceRoomIdentity[]>([]);
  /** The visit stack, most-recently-visited first. */
  readonly visited = this._visited.asReadonly();

  /** Snapshot of the stack taken when a hop cycle began, or null when not cycling. */
  private hopSnapshot: WorkspaceRoomIdentity[] | null = null;
  private hopIndex = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Record a user-driven visit: move it to the front (deduped, capped) and end any hop cycle
   * in progress; the explicit open is the commit.
   */
  record(room: WorkspaceRoomIdentity): void {
    this.endHop();
    this._visited.update((visited) =>
      [room, ...visited.filter((existing) => !sameRoom(existing, room))].slice(
        0,
        MAX_VISITS,
      ),
    );
  }

  /**
   * Step through the visit stack alt-tab style and return the room to open, or null when
   * there is nowhere to hop. `current` is forced to the front of the snapshot so a hop starts
   * from "here"; `knownRooms` are the rooms that still exist, so a left or forgotten room is
   * skipped. The first hop of a cycle snapshots the stack; later hops walk that frozen order
   * (clamped at both ends). Each press re-arms the idle commit ({@link HOP_IDLE_MS}).
   */
  hop(
    direction: HopDirection,
    current: WorkspaceRoomIdentity | null,
    knownRooms: readonly WorkspaceRoomIdentity[],
  ): WorkspaceRoomIdentity | null {
    if (!this.hopSnapshot) {
      const ordered = current
        ? [
            current,
            ...this._visited().filter((room) => !sameRoom(room, current)),
          ]
        : [...this._visited()];
      this.hopSnapshot = ordered.filter((room) =>
        knownRooms.some((known) => sameRoom(known, room)),
      );
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
   * The Nth most-recently-visited room, skipping the one open now, so Ctrl/Cmd+1 is the
   * previous room. Null when the stack is too short.
   */
  nth(
    n: number,
    current: WorkspaceRoomIdentity | null,
    knownRooms: readonly WorkspaceRoomIdentity[] = this._visited(),
  ): WorkspaceRoomIdentity | null {
    const available = this._visited().filter((room) =>
      knownRooms.some((known) => sameRoom(known, room)),
    );
    const others = current
      ? available.filter((room) => !sameRoom(room, current))
      : available;
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
