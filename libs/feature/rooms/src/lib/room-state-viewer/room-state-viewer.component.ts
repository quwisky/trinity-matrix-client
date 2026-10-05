import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { TrnButton, TrnInput } from '@trinity/components/controls';
import {
  TrnDialogRef,
  TrnOverlaySurfaceDirective,
  TrnToastService,
} from '@trinity/components/overlay';
import type { RoomStateEntry } from '@trinity/data-access/room-administration';
import { copyText } from '../shared/copy-text';

/** One event type's current state events, in state-key order. */
export interface RoomStateGroup {
  readonly type: string;
  readonly entries: readonly RoomStateEntry[];
}

/**
 * Read-only "view room state" dialog, styled like the message source view. Groups start
 * collapsed and an event's JSON renders only once expanded: a large room carries thousands
 * of member events, and stringifying them all up front would stall the dialog.
 */
@Component({
  selector: 'trn-room-state-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormField, TrnButton, TrnInput, TrnOverlaySurfaceDirective],
  templateUrl: './room-state-viewer.component.html',
})
export class RoomStateViewerComponent {
  private readonly dialogRef = inject<TrnDialogRef<void>>(TrnDialogRef);
  private readonly toast = inject(TrnToastService);
  private readonly filterModel = signal({ query: '' });
  private readonly openGroups = signal<ReadonlySet<string>>(new Set());
  private readonly openEvents = signal<ReadonlySet<string>>(new Set());

  readonly entries = input.required<readonly RoomStateEntry[]>();
  readonly filter = form(this.filterModel);
  readonly groups = computed<readonly RoomStateGroup[]>(() => {
    const needle = this.filterModel().query.trim().toLowerCase();
    const matching = this.entries().filter(
      ({ type, stateKey }) =>
        !needle ||
        type.toLowerCase().includes(needle) ||
        stateKey.toLowerCase().includes(needle),
    );
    const sorted = [...matching].sort(
      (a, b) => compare(a.type, b.type) || compare(a.stateKey, b.stateKey),
    );
    const groups: { type: string; entries: RoomStateEntry[] }[] = [];
    for (const entry of sorted) {
      const last = groups.at(-1);
      if (last?.type === entry.type) last.entries.push(entry);
      else groups.push({ type: entry.type, entries: [entry] });
    }
    return groups;
  });

  isGroupOpen(type: string): boolean {
    return this.openGroups().has(type);
  }

  toggleGroup(type: string): void {
    this.openGroups.update((open) => toggled(open, type));
  }

  isEventOpen(entry: RoomStateEntry): boolean {
    return this.openEvents().has(eventKey(entry));
  }

  toggleEvent(entry: RoomStateEntry): void {
    this.openEvents.update((open) => toggled(open, eventKey(entry)));
  }

  json(entry: RoomStateEntry): string {
    return JSON.stringify(entry.event, null, 2);
  }

  copyLabel({ type, stateKey }: RoomStateEntry): string {
    return `Copy ${type}${stateKey ? ` ${stateKey}` : ''} event JSON`;
  }

  copy(entry: RoomStateEntry): void {
    copyText(this.json(entry), 'Event JSON', this.toast);
  }

  close(): void {
    this.dialogRef.close();
  }
}

/** Type and state key joined on NUL, which Matrix identifiers do not carry in practice. */
function eventKey({ type, stateKey }: RoomStateEntry): string {
  return `${type}\u0000${stateKey}`;
}

function toggled(open: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(open);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** Code-point order: identical in every locale, which protocol identifiers want. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
