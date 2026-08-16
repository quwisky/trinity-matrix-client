import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  input,
  output,
} from '@angular/core';
import { HlmCheckbox } from '@trinity/helm/checkbox';

/**
 * Trinity's checkbox.
 *
 * An element, matching the thing it replaces, composed by template because the kit ships a
 * component and `hostDirectives` accepts only directives.
 *
 * The surface is four things, which is what the 15 call sites actually use: `checked` in,
 * `checkedChange` out, `disabled` on two of them, and `aria-label` on one. The kit publishes
 * eleven inputs — `indeterminate`, `name`, `required`, `inputId`, `aria-labelledby`,
 * `aria-describedby`, `forceInvalid` and a `ControlValueAccessor` — and none of them is
 * bound anywhere in this workspace. Every one kept would be another promise a replacement
 * library has to honour; each is one line to add when something needs it.
 *
 * The `ControlValueAccessor` in particular is deliberately not re-exposed: this workspace
 * uses Signal Forms only, no call site binds a checkbox to a form control, and re-publishing
 * a forms integration nobody uses would tie the public API to `@angular/forms` for nothing.
 *
 * Labelling is the caller's, and already works: every call site wraps the checkbox in its
 * own `<label>` carrying the text and the `data-testid`, which is why `aria-labelledby` has
 * no users. `aria-label` is forwarded for the one place that has no visible text.
 */
@Component({
  selector: 'trn-checkbox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmCheckbox],
  styles: [':host { display: contents; }'],
  template: `
    <hlm-checkbox
      [checked]="checked()"
      [disabled]="disabled()"
      [aria-label]="ariaLabel()"
      (checkedChange)="checkedChange.emit($event)"
    />
  `,
})
export class TrnCheckboxComponent {
  readonly checked = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });

  /** For a checkbox with no visible label of its own. */
  readonly ariaLabel = input<string | null>(null, { alias: 'aria-label' });

  readonly checkedChange = output<boolean>();
}
