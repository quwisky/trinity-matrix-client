import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { TrnInput } from '@trinity/components/controls';
import { TrnLabel } from '@trinity/components/controls';
import {
  TrnDialogRef,
  TrnOverlaySurfaceDirective,
} from '@trinity/components/overlay';
import { TrnIconComponent } from '@trinity/components/foundations';

/** The poll a {@link CreatePollDialogComponent} resolves with. */
export interface NewPoll {
  question: string;
  options: string[];
  /** How many answers one voter may choose, within `[1, options.length]`. */
  maxSelections: number;
}

/** Fewest / most answers a poll may have. */
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 8;

/**
 * Dialog to compose a poll: a question, two-to-eight answers, and how many of them a
 * voter may choose. Closes with the
 * {@link NewPoll} on create, or `null` when cancelled. Presented by
 * {@link CreatePollService}; it builds and sends nothing itself.
 */
@Component({
  selector: 'trn-create-poll-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TrnButton,
    TrnInput,
    TrnLabel,
    TrnIconComponent,
    TrnOverlaySurfaceDirective,
  ],
  templateUrl: './create-poll-dialog.component.html',
})
export class CreatePollDialogComponent {
  private readonly dialogRef =
    inject<TrnDialogRef<NewPoll | null>>(TrnDialogRef);

  readonly maxOptions = MAX_OPTIONS;
  readonly minOptions = MIN_OPTIONS;
  readonly question = signal('');
  readonly options = signal<string[]>(['', '']);
  /** The requested max selections, as typed; see {@link effectiveMaxSelections}. */
  readonly maxSelections = signal(1);

  /** Number of non-empty answers. */
  readonly filledOptions = computed(
    () => this.options().filter((o) => o.trim().length > 0).length,
  );

  /** Most selections the current answers allow (at least 1). */
  readonly selectionLimit = computed(() => Math.max(this.filledOptions(), 1));

  /** {@link maxSelections} clamped to `[1, selectionLimit]`. */
  readonly effectiveMaxSelections = computed(() =>
    Math.min(Math.max(this.maxSelections(), 1), this.selectionLimit()),
  );

  /** A question and at least two non-empty answers are required to create. */
  readonly valid = computed(
    () =>
      this.question().trim().length > 0 && this.filledOptions() >= MIN_OPTIONS,
  );

  onQuestion(event: Event): void {
    this.question.set((event.target as HTMLInputElement).value);
  }

  onOption(index: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.options.update((list) =>
      list.map((o, i) => (i === index ? value : o)),
    );
  }

  onMaxSelections(event: Event): void {
    const field = event.target as HTMLInputElement;
    const value = Math.trunc(field.valueAsNumber);
    if (!Number.isFinite(value)) {
      this.maxSelections.set(1); // cleared mid-edit: leave the field alone
      return;
    }
    this.maxSelections.set(value);
    // The `[value]` binding won't rewrite the field when the clamped value is
    // unchanged, so reflect it here to keep what's shown equal to what's sent.
    field.value = String(this.effectiveMaxSelections());
  }

  addOption(): void {
    if (this.options().length < MAX_OPTIONS) {
      this.options.update((list) => [...list, '']);
    }
  }

  removeOption(index: number): void {
    if (this.options().length > MIN_OPTIONS) {
      this.options.update((list) => list.filter((_, i) => i !== index));
    }
  }

  create(): void {
    if (!this.valid()) {
      return;
    }
    this.dialogRef.close({
      question: this.question().trim(),
      options: this.options()
        .map((o) => o.trim())
        .filter(Boolean),
      maxSelections: this.effectiveMaxSelections(),
    });
  }

  cancel(): void {
    this.dialogRef.close(null);
  }
}
