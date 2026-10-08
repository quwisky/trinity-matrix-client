import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { EmptyStateComponent } from '@trinity/components/generic-content';
import { TrnButton } from '@trinity/components/controls';
import { TrnDialogShellComponent } from '@trinity/components/overlay';
import {
  ConversationRuntime,
  type ReactionDetail,
} from '@trinity/data-access/timeline';
import { AvatarComponent } from '@trinity/components/generic-content';
import { textScaledViewportSignal } from '@trinity/util/ui';

/**
 * Dialog listing everyone who reacted to a message, one section per emoji.
 *
 * Reads the reactors once from the focused Conversation timeline when it opens —
 * a snapshot, not a live tally. The pills under the message stay live either way, and
 * this is a list you open, read and close; re-ordering it under the reader's finger
 * while they scan for a name would be worse than showing the moment they asked about.
 */
@Component({
  selector: 'trn-reactions-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './reactions-dialog.component.html',
  styleUrl: './reactions-dialog.component.scss',
  imports: [
    EmptyStateComponent,
    AvatarComponent,
    TrnButton,
    TrnDialogShellComponent,
  ],
})
export class ReactionsDialogComponent implements OnInit {
  private readonly timeline = inject(ConversationRuntime).timeline;

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

  /** Keep the directory and detail panes together only when the text scale permits it. */
  readonly wide = textScaledViewportSignal(48, inject(DestroyRef));

  // Read here, not in the constructor: TrnSurfaceService sets the inputs after the
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
}
