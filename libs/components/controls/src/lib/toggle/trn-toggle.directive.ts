import {
  DestroyRef,
  Directive,
  ElementRef,
  booleanAttribute,
  inject,
  input,
  model,
} from '@angular/core';
import { classes } from '@trinity/helm/utils';
import {
  normalizeTrnTogglePresentation,
  normalizeTrnToggleSize,
  normalizeTrnToggleVariant,
  trnToggleRecipe,
  type TrnTogglePresentation,
  type TrnToggleSize,
  type TrnToggleVariant,
} from './trn-toggle-recipe';

/**
 * A standalone pressed-state button with Trinity-owned visuals.
 *
 * The native button keeps activation and disabled semantics. `pressed` is a model so an
 * uncontrolled toggle updates itself while a two-way-bound consumer can own the state.
 * Read-only toggles remain focusable and report their state, but activation is intercepted
 * before consumer click handlers run.
 */
@Directive({
  selector: 'button[trnToggle]',
  host: {
    type: 'button',
    'data-trn-toggle': '',
    '[attr.aria-pressed]': 'pressed()',
    '[attr.aria-disabled]': 'readOnly() ? "true" : null',
    '[attr.data-state]': 'pressed() ? "on" : "off"',
    '(click)': 'toggle()',
  },
})
export class TrnToggleDirective {
  private readonly element = inject<ElementRef<HTMLButtonElement>>(ElementRef);

  protected toggle(): void {
    if (!this.readOnly() && !this.element.nativeElement.disabled) {
      this.pressed.set(!this.pressed());
    }
  }

  readonly pressed = model(false);
  readonly readOnly = input(false, { transform: booleanAttribute });
  readonly variant = input<TrnToggleVariant>('neutral');
  readonly size = input<TrnToggleSize>('md');
  readonly presentation = input<TrnTogglePresentation>('plain');

  constructor() {
    classes(() =>
      trnToggleRecipe({
        presentation: normalizeTrnTogglePresentation(
          this.variant(),
          this.presentation(),
        ),
        size: normalizeTrnToggleSize(this.size()),
        variant: normalizeTrnToggleVariant(this.variant()),
      }),
    );

    const blockReadOnly = (event: Event): void => {
      if (!this.readOnly()) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    this.element.nativeElement.addEventListener('click', blockReadOnly, true);
    inject(DestroyRef).onDestroy(() =>
      this.element.nativeElement.removeEventListener(
        'click',
        blockReadOnly,
        true,
      ),
    );
  }
}
