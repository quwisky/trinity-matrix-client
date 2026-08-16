import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { TrnDialogRef } from '@trinity/helm/overlay';
import { FormField, FormRoot, form } from '@angular/forms/signals';
import { HlmButton } from '@trinity/helm/button';
import { HlmInput } from '@trinity/helm/input';
import { isoDateOf, localDayStartFromIso } from '@trinity/util/matrix';

/**
 * Pick a calendar day to scroll the timeline back to. Closes with the epoch-ms local
 * midnight of the chosen day, or `undefined` when cancelled — resolving the DATE only, so
 * this component knows nothing about `/timestamp_to_event` or pagination
 * ({@link TimelineService.jumpToDate} owns both).
 *
 * A native `<input type="date">` rather than a calendar widget: there is no Helm calendar
 * in this workspace, and the native control brings a real date picker on iOS and Android,
 * keyboard entry on the desktop, and localised formatting and screen-reader support that a
 * hand-rolled grid would have to reimplement.
 */
@Component({
  selector: 'trn-jump-to-date',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormField, FormRoot, HlmButton, HlmInput],
  templateUrl: './jump-to-date.component.html',
  styleUrl: './jump-to-date.component.scss',
})
export class JumpToDateComponent {
  private readonly dialogRef =
    inject<TrnDialogRef<number | undefined>>(TrnDialogRef);

  /** Seeded to today, which is both a sensible default and a valid value. */
  private readonly model = signal({ date: isoDateOf(Date.now()) });
  readonly dateForm = form(this.model);

  /** No point offering the future: `timestampToEvent` would find nothing after it. */
  readonly today = isoDateOf(Date.now());

  /** Epoch ms for the chosen day, or null while the field holds nothing usable. */
  private readonly chosen = computed(() =>
    localDayStartFromIso(this.model().date),
  );

  readonly canJump = computed(() => this.chosen() !== null);

  jump(): void {
    const at = this.chosen();
    if (at === null) {
      return;
    }
    this.dialogRef.close(at);
  }

  cancel(): void {
    this.dialogRef.close(undefined);
  }
}
