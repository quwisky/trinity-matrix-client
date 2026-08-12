import { Directive } from '@angular/core';
import { classes } from '@trinity/kit/utils';

@Directive({
	selector: '[trnCardAction]',
	host: { 'data-slot': 'card-action' },
})
export class TrnCardAction {
	constructor() {
		classes(() => 'col-start-2 row-span-2 row-start-1 self-start justify-self-end');
	}
}
