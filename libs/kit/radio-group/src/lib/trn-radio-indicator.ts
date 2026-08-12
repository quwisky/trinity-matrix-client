import { ChangeDetectionStrategy, Component } from '@angular/core';
import { classes } from '@trinity/kit/utils';

@Component({
  selector: 'trn-radio-indicator',
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
export class TrnRadioIndicator {
  constructor() {
    classes(
      () =>
        'border-input text-primary group-has-[:focus-visible]:border-ring group-has-[:focus-visible]:ring-ring/50 dark:bg-input/30 group-data=[disabled=true]:cursor-not-allowed group-data=[disabled=true]:opacity-50 relative flex aspect-square size-4 shrink-0 items-center justify-center rounded-full border shadow-xs transition-[color,box-shadow] outline-none group-has-[:focus-visible]:ring-[3px]',
    );
  }
}
