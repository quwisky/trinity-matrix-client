import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
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
  host: {
    '(keydown)': 'onKeyDown($event)',
  },
})
export class SearchSenderPickerComponent {
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  readonly members = input.required<readonly MemberSummary[]>();
  /** The user id the search is narrowed to now; null for anyone. */
  readonly selected = input<string | null>(null);
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

  constructor() {
    afterNextRender(() =>
      this.host.nativeElement.querySelector<HTMLElement>('input')?.focus(),
    );
  }

  /** The field and the options form one list: arrows, Home and End move along it. */
  protected onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.dismissed.emit();
      return;
    }
    const stops = [
      ...this.host.nativeElement.querySelectorAll<HTMLElement>(
        'input, .picker__option',
      ),
    ];
    const at = stops.indexOf(event.target as HTMLElement);
    const last = stops.length - 1;
    const onField = at === 0;
    const next =
      event.key === 'ArrowDown'
        ? Math.min(at + 1, last)
        : event.key === 'ArrowUp'
          ? Math.max(at - 1, 0)
          : event.key === 'Home' && !onField
            ? 1
            : event.key === 'End' && !onField
              ? last
              : null;
    if (at < 0 || next === null) {
      return;
    }
    event.preventDefault();
    stops[next].focus();
  }

  protected pick(member: MemberSummary): void {
    this.picked.emit({ id: member.userId, name: member.roomDisplayName });
  }
}
