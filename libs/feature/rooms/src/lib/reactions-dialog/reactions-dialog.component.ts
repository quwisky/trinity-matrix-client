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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

/**
 * Dialog listing everyone who reacted to a message, one section per emoji. Reads the reactors
 * once from the focused Conversation timeline when it opens: a snapshot, not a live tally,
 * because re-ordering the list under the reader's finger while they scan for a name is worse
 * than showing the moment they asked about. The pills under the message stay live.
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
  private readonly destroyRef = inject(DestroyRef);

  readonly eventId = input.required<string>();

  /** The reactors by reaction key as they stood when the dialog opened; null until read. */
  readonly sections = signal<readonly ReactionDetail[] | null>(null);

  /** The key whose reactors are listed, or null before the snapshot is read. */
  readonly selectedKey = signal<string | null>(null);

  readonly selected = computed<ReactionDetail | null>(
    () =>
      this.sections()?.find((s) => s.key === this.selectedKey()) ??
      this.sections()?.[0] ??
      null,
  );

  /** "N total" once the snapshot is read. */
  readonly summary = computed(() => {
    const sections = this.sections();
    return sections
      ? `${sections.reduce((sum, s) => sum + s.reactors.length, 0)} total`
      : undefined;
  });

  /** Keep the directory and detail panes together only when the text scale permits it. */
  readonly wide = textScaledViewportSignal(48, this.destroyRef);

  // Read here, not in the constructor: TrnSurfaceService sets the inputs after creation but
  // before the first change detection. Nothing to react to afterwards; the list is a snapshot.
  ngOnInit(): void {
    this.timeline
      .reactionDetails(this.eventId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((sections) => {
        this.sections.set(sections);
        this.selectedKey.set(sections[0]?.key ?? null);
      });
  }

  select(key: string): void {
    this.selectedKey.set(key);
  }
}
