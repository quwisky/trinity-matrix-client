import { Directive } from '@angular/core';
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
  hostDirectives: [
    {
      directive: HlmButton,
      inputs: ['variant', 'size'],
      outputs: [],
    },
  ],
})
export class TrnButton {}

export const TrnButtonImports = [TrnButton] as const;
