import { Directive } from '@angular/core';
import { BrnSelectGroup } from '@spartan-ng/brain/select';
import { classes } from '@trinity/helm/utils';

@Directive({
	selector: '[hlmSelectGroup],hlm-select-group',
	hostDirectives: [{ directive: BrnSelectGroup, inputs: [] }],
	host: { 'data-slot': 'select-group' },
})
export class HlmSelectGroup {
	constructor() {
		classes(() => 'scroll-my-1 p-1');
	}
}
