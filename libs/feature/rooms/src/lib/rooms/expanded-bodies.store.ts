import { Injectable, inject, linkedSignal } from '@angular/core';
import { RoomShellStore } from './room-shell-store';

/**
 * Which long message bodies the reader has expanded. Provided by the rooms page and shared by
 * the timeline and the thread view, so a row keeps its state as the windowed list lets it go
 * and brings it back. Keyed by the original event id, so an edit keeps the state. Every change
 * of the selected account or room starts from an empty set.
 */
@Injectable()
export class ExpandedBodiesStore {
  private readonly shell = inject(RoomShellStore);
  private readonly ids = linkedSignal<string, ReadonlySet<string>>({
    source: () =>
      `${this.shell.activeAccountId() ?? ''}\u0000${this.shell.activeRoomId() ?? ''}`,
    computation: () => new Set<string>(),
  });

  /** The expanded row ids of the selected room. */
  readonly expanded = this.ids.asReadonly();

  isExpanded(id: string): boolean {
    return this.ids().has(id);
  }

  /** Expand a row; a no-op when it already is (jump targets ask repeatedly). */
  expand(id: string): void {
    if (!this.ids().has(id)) {
      this.ids.update((ids) => new Set(ids).add(id));
    }
  }

  toggle(id: string): void {
    this.ids.update((ids) => {
      const next = new Set(ids);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }
}
