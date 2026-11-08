import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { TrnInput } from '@trinity/components/controls';
import { type MemberSummary } from '@trinity/data-access/room-administration';

/** The author a search is narrowed to. */
export interface SenderFilter {
  readonly id: string;
  readonly name: string;
}

/** People shown at once: enough to pick from, few enough to render in a 10,000-member room. */
const MAX_OPTIONS = 20;

/**
 * Picks whose messages a search keeps: a field that narrows the room's members by name or
 * user id, over a capped list. A menu of every member would render the whole roster.
 */
@Component({
  selector: 'trn-search-sender-picker',
  imports: [TrnInput],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './search-sender-picker.component.html',
  styleUrl: './search-sender-picker.component.scss',
})
export class SearchSenderPickerComponent {
  readonly members = input.required<readonly MemberSummary[]>();
  readonly picked = output<SenderFilter | null>();
  readonly dismissed = output<void>();

  protected readonly query = signal('');

  private readonly matching = computed(() => {
    const needle = this.query().trim().toLowerCase();
    const members = this.members();
    return needle
      ? members.filter(
          (m) =>
            m.roomDisplayName.toLowerCase().includes(needle) ||
            m.userId.toLowerCase().includes(needle),
        )
      : members;
  });

  protected readonly options = computed(() =>
    this.matching().slice(0, MAX_OPTIONS),
  );

  /** How many matches the cap leaves out, as "9,980". */
  protected readonly more = computed(() => {
    const left = this.matching().length - MAX_OPTIONS;
    return left > 0 ? left.toLocaleString() : null;
  });

  protected pick(member: MemberSummary): void {
    this.picked.emit({ id: member.userId, name: member.roomDisplayName });
  }
}
