import { ChangeDetectionStrategy, Component } from '@angular/core';
import { classes } from '@trinity/helm/utils';

/**
 * VENDORED FILE — local override: the radio control uses Trinity's semantic raised
 * elevation instead of Tailwind's open-ended default shadow scale. A regenerate drops it;
 * scripts/theme-foundation-contract.spec.mjs pins the role.
 */

@Component({
  selector: 'hlm-radio-indicator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'data-slot': 'radio-group-indicator',
  },
  template: `
    <div
      class="group-data-[checked=true]:bg-primary size-2 rounded-full bg-transparent"
    ></div>
  `,
})
export class HlmRadioIndicator {
  constructor() {
    // Trinity override: controls use the raised elevation role.
    classes(
      () =>
        'border-input text-primary group-has-[:focus-visible]:border-ring group-has-[:focus-visible]:ring-ring/50 dark:bg-input/30 group-data=[disabled=true]:cursor-not-allowed group-data=[disabled=true]:opacity-50 relative flex aspect-square size-4 shrink-0 items-center justify-center rounded-full border shadow-raised transition-[color,box-shadow] outline-none group-has-[:focus-visible]:ring-[3px]',
    );
  }
}
