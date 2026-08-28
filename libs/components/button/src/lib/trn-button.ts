import { computed, Directive, inject } from '@angular/core';
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

export const TrnButtonImports = [TrnButton] as const;
