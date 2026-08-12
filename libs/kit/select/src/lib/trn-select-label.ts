import { Directive } from '@angular/core';
import { BrnSelectLabel } from '@spartan-ng/brain/select';
import { classes } from '@trinity/kit/utils';

@Directive({
	selector: '[trnSelectLabel],trn-select-label',
	hostDirectives: [{ directive: BrnSelectLabel, inputs: ['id'] , outputs: [] }],
	host: { 'data-slot': 'select-label' },
})
export class TrnSelectLabel {
	constructor() {
		classes(() => 'text-muted-foreground px-1.5 py-1 text-xs flex');
	}
}
