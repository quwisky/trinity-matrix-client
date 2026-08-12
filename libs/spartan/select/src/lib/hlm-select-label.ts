import { Directive } from '@angular/core';
import { BrnSelectLabel } from '@spartan-ng/brain/select';
import { classes } from '@trinity/helm/utils';

@Directive({
	selector: '[hlmSelectLabel],hlm-select-label',
	hostDirectives: [{ directive: BrnSelectLabel, inputs: ['id'] , outputs: [] }],
	host: { 'data-slot': 'select-label' },
})
export class HlmSelectLabel {
	constructor() {
		classes(() => 'text-muted-foreground px-1.5 py-1 text-xs flex');
	}
}
