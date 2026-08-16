import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { TrnDialogRef } from '@trinity/components/overlay';
import { HlmButton } from '@trinity/helm/button';
import { TimelineService } from '@trinity/data-access/timeline';
import { AvatarComponent } from '@trinity/ui';
import { type ReactionDetail } from '@trinity/util/matrix';

/**
 * Dialog listing everyone who reacted to a message, one section per emoji.
 *
 * Reads the reactors once, when it opens ({@link TimelineService.reactionDetails}) —
 * a snapshot, not a live tally. The pills under the message stay live either way, and
 * this is a list you open, read and close; re-ordering it under the reader's finger
 * while they scan for a name would be worse than showing the moment they asked about.
 */
@Component({
  selector: 'trn-reactions-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './reactions-dialog.component.html',
  styleUrl: './reactions-dialog.component.scss',
  imports: [AvatarComponent, HlmButton],
})
export class ReactionsDialogComponent implements OnInit {
  private readonly timeline = inject(TimelineService);
  private readonly dialogRef = inject<TrnDialogRef<void>>(TrnDialogRef);

  /** The message whose reactors to list (populated from the dialog's `inputs`). */
  readonly eventId = input.required<string>();

  /** The reactors, grouped by reaction key, as they stood when the dialog opened. */
  readonly sections = signal<ReactionDetail[]>([]);

  /** The key whose reactors are listed, or null before the snapshot is read. */
  readonly selectedKey = signal<string | null>(null);

  readonly selected = computed<ReactionDetail | null>(
    () =>
      this.sections().find((s) => s.key === this.selectedKey()) ??
      this.sections()[0] ??
      null,
  );

  /** Total reactions across every key, for the dialog's subtitle. */
  readonly total = computed(() =>
    this.sections().reduce((sum, s) => sum + s.reactors.length, 0),
  );

  // Read here, not in the constructor: TrnDialogService sets the inputs after the
  // component is created but before the first change detection. Nothing to react to
  // afterwards — the list is a snapshot.
  ngOnInit(): void {
    const sections = this.timeline.reactionDetails(this.eventId());
    this.sections.set(sections);
    this.selectedKey.set(sections[0]?.key ?? null);
  }

  select(key: string): void {
    this.selectedKey.set(key);
  }

  close(): void {
    this.dialogRef.close();
  }
}
