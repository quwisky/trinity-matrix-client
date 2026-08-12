import { Directive } from '@angular/core';
import { BrnProgress } from '@spartan-ng/brain/progress';
import { classes } from '@trinity/helm/utils';

@Directive({
  selector: 'hlm-progress,[hlmProgress]',
  hostDirectives: [
    { directive: BrnProgress, inputs: ['value', 'max', 'getValueLabel'] , outputs: [] }],
  host: { 'data-slot': 'progress' },
})
export class HlmProgress {
  constructor() {
    classes(
      () =>
        'bg-muted h-1 rounded-full relative inline-flex w-full overflow-hidden',
    );
  }
}
