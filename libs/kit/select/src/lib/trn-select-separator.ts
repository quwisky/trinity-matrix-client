import { Directive } from '@angular/core';
import { BrnSelectSeparator } from '@spartan-ng/brain/select';
import { classes } from '@trinity/kit/utils';

@Directive({
	selector: '[trnSelectSeparator],trn-select-separator',
	hostDirectives: [{ directive: BrnSelectSeparator, inputs: ['orientation'] , outputs: [] }],
	host: { 'data-slot': 'select-separator' },
})
export class TrnSelectSeparator {
	constructor() {
		classes(() => 'bg-border -mx-1 my-1 h-px pointer-events-none');
	}
}
