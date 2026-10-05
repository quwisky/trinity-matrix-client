import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  booleanAttribute,
  contentChild,
  effect,
  input,
  signal,
} from '@angular/core';
import { TrnIconComponent } from '@trinity/components/foundations';
import { TrnButton } from '../button/trn-button';
import { TrnInput } from '../input/trn-input';

/**
 * Wraps a projected `<input trnInput>` and shows its show/hide-password toggle inside the
 * field's trailing edge.
 *
 * The page keeps the input, so Signal Forms `[formField]`, `id`, `aria-describedby` and
 * `keyup.enter` stay where they were authored. This component owns only the visible state and
 * writes the input's native `type` property from a content query; the page must not bind
 * `[type]` itself. Signal Forms never writes `type`, so the two do not fight.
 *
 * The button is `type="button"`, so Enter in the field still submits through the page.
 */
@Component({
  selector: 'trn-password-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnIconComponent],
  host: {
    class: 'relative block [&>input]:pe-12',
  },
  template: `
    <ng-content />
    <button
      trnBtn
      presentation="ghost"
      shape="icon"
      size="sm"
      type="button"
      class="absolute end-0.5 top-1/2 -translate-y-1/2 pointer-coarse:size-10"
      [attr.aria-label]="visible() ? 'Hide password' : 'Show password'"
      [attr.aria-pressed]="visible()"
      [disabled]="disabled()"
      (click)="visible.set(!visible())"
    >
      <trn-icon [name]="visible() ? 'eye-off' : 'eye'" motion="pop" />
    </button>
  `,
})
export class TrnPasswordInputComponent {
  private readonly field = contentChild(TrnInput, { read: ElementRef });

  readonly disabled = input(false, { transform: booleanAttribute });
  protected readonly visible = signal(false);

  constructor() {
    effect(() => {
      const element = this.field()?.nativeElement as
        HTMLInputElement | undefined;
      if (element) element.type = this.visible() ? 'text' : 'password';
    });
  }
}
