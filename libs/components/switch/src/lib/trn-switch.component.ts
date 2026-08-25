import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  input,
  output,
} from '@angular/core';
import { HlmSwitch } from '@trinity/helm/switch';

/**
 * Trinity's switch: a preference that takes effect as you set it.
 *
 * An element, matching the thing it replaces, composed by template because the kit ships a
 * component and `hostDirectives` accepts only directives — the same shape and the same reason
 * as `trn-checkbox`, which this deliberately mirrors input for input.
 *
 * ## Why a second control rather than a flag on the first
 *
 * A checkbox and a switch are not a style choice. A checkbox is one of several answers you
 * submit together; a switch is a setting that applies the moment you touch it, and it says so
 * by looking like a physical one. Eleven of Trinity's fifteen checkboxes are settings —
 * appearance, privacy, notifications, the experimental flags — and each takes effect
 * immediately with nothing to submit. The other four are genuine multi-select: two room
 * pickers, the room-settings history options, and an acknowledgement you tick before
 * continuing. Those stay checkboxes, and that is why this is a new component rather than a
 * `variant` on the old one.
 *
 * ## The surface is the same four things
 *
 * `checked` in, `checkedChange` out, `disabled`, and `aria-label` for a switch with no visible
 * label of its own. `BrnSwitch` also publishes `size`, `inputId`, `name`, `required`, the
 * `aria-labelledby`/`aria-describedby` pair and a `ControlValueAccessor`; none is bound
 * anywhere in this workspace. Each one kept would be another promise a replacement library has
 * to honour, and each is one line to add when something needs it.
 *
 * The `ControlValueAccessor` is left unexposed for the reason `trn-checkbox` records: this
 * workspace uses Signal Forms only, and re-publishing a `@angular/forms` integration nobody
 * binds would tie the public API to it for nothing.
 *
 * Labelling is the caller's and already works — every call site wraps the control in its own
 * `<label>` carrying the text and the `data-testid`, which is why `aria-labelledby` has no
 * users here either.
 */
@Component({
  selector: 'trn-switch',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmSwitch],
  styles: [':host { display: contents; }'],
  template: `
    <hlm-switch
      [checked]="checked()"
      [disabled]="disabled()"
      [aria-label]="ariaLabel()"
      (checkedChange)="checkedChange.emit($event)"
    />
  `,
})
export class TrnSwitchComponent {
  readonly checked = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });

  /** For a switch with no visible label of its own. */
  readonly ariaLabel = input<string | null>(null, { alias: 'aria-label' });

  readonly checkedChange = output<boolean>();
}
