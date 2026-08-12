import { Directive } from '@angular/core';
import { classes } from '@trinity/kit/utils';

@Directive({
	selector: '[trnCardTitle]',
	host: { 'data-slot': 'card-title' },
})
export class TrnCardTitle {
	constructor() {
		classes(() => 'text-base leading-snug font-medium group-data-[size=sm]/card:text-sm');
	}
}
