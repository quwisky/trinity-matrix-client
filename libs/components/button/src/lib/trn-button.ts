import {
  computed,
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  input,
} from '@angular/core';
import { HlmButton } from '@trinity/helm/button';

/**
 * Trinity's public button directive.
 *
 * Feature code owns the semantic element and asks for Trinity's button treatment with
 * `trnBtn`. Variant and size are the supported styling surface; native button semantics
 * (including `disabled`) remain owned by the host element. The Helm directive
 * remains behind this boundary so a substrate change does not touch feature templates.
 */
@Directive({
  selector: 'button[trnBtn], a[trnBtn]',
  exportAs: 'trnBtn',
  host: {
    '[attr.data-trn-icon-button]': "iconButton() ? '' : null",
  },
  hostDirectives: [
    {
      directive: HlmButton,
      inputs: ['variant', 'size'],
      outputs: [],
    },
  ],
})
export class TrnButton {
  private readonly helm = inject(HlmButton, { self: true });

  /**
   * Icon sizes opt into Trinity's shared icon-button interaction contract.
   *
   * Keep this derived from Helm's public input instead of reading the host attribute: bound
   * sizes need to update reactively, and the public wrapper is the layer that owns the marker.
   */
  protected readonly iconButton = computed(() =>
    this.helm.size()?.startsWith('icon'),
  );
}

/**
 * Keeps an unavailable action discoverable without letting it activate.
 *
 * Native disabled buttons cannot receive focus or pointer events, so their explanatory
 * tooltip is unreachable. This directive uses the ARIA disabled contract instead, exposes
 * the reason to assistive technology, and blocks pointer plus Enter/Space activation in the
 * capture phase. Arrow keys remain untouched so unavailable dropdown items stay in the
 * menu's normal roving-focus order.
 */
@Directive({
  selector: '[trnActionAllowed]',
  host: {
    '[attr.aria-disabled]': 'trnActionAllowed() ? null : "true"',
    '[attr.aria-description]':
      'trnActionAllowed() ? null : trnActionDisabledReason()',
    '[attr.data-trn-action-disabled]': 'trnActionAllowed() ? null : ""',
  },
})
export class TrnActionAvailability {
  readonly trnActionAllowed = input(true);
  readonly trnActionDisabledReason = input<string | null>(null);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    const element = this.host.nativeElement;
    const blockClick = (event: Event): void => this.block(event);
    const blockActivationKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' || event.key === ' ') {
        this.block(event);
      }
    };
    element.addEventListener('click', blockClick, true);
    element.addEventListener('keydown', blockActivationKey, true);
    this.destroyRef.onDestroy(() => {
      element.removeEventListener('click', blockClick, true);
      element.removeEventListener('keydown', blockActivationKey, true);
    });
  }

  private block(event: Event): void {
    if (this.trnActionAllowed()) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

/**
 * Opts a purpose-built icon control into Trinity's shared interaction contract.
 *
 * Use this only when `trnBtn` would replace meaningful component-owned geometry, such as a
 * circular avatar action, server-rail pill, reaction chip or compact message toolbar control.
 */
@Directive({
  selector: 'button[trnIconButton], a[trnIconButton]',
  host: {
    '[attr.data-trn-icon-button]': "''",
  },
})
export class TrnIconButton {}

export const TrnButtonImports = [
  TrnButton,
  TrnIconButton,
  TrnActionAvailability,
] as const;
