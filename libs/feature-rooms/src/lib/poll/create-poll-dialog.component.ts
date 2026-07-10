import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { HlmButton } from '@trinity/helm/button';
import { HlmInput } from '@trinity/helm/input';
import { HlmLabel } from '@trinity/helm/label';
import { DialogRef } from '@trinity/helm/overlay';

/** The poll a {@link CreatePollDialogComponent} resolves with. */
export interface NewPoll {
  question: string;
  options: string[];
}

/** Fewest / most answers a poll may have. */
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 8;

/**
 * Dialog to compose a poll: a question plus two-to-eight answers. Closes with the
 * {@link NewPoll} on create, or `null` when cancelled. Presented by
 * {@link CreatePollService}; it builds and sends nothing itself.
 */
@Component({
  selector: 'trn-create-poll-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButton, HlmInput, HlmLabel],
  templateUrl: './create-poll-dialog.component.html',
})
export class CreatePollDialogComponent {
  private readonly dialogRef = inject<DialogRef<NewPoll | null>>(DialogRef);

  readonly maxOptions = MAX_OPTIONS;
  readonly question = signal('');
  readonly options = signal<string[]>(['', '']);

  /** A question and at least two non-empty answers are required to create. */
  readonly valid = computed(
    () =>
      this.question().trim().length > 0 &&
      this.options().filter((o) => o.trim().length > 0).length >= MIN_OPTIONS,
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

  addOption(): void {
    if (this.options().length < MAX_OPTIONS) {
      this.options.update((list) => [...list, '']);
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
    });
  }

  cancel(): void {
    this.dialogRef.close(null);
  }
}
