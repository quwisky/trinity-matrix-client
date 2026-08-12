import { Directive } from '@angular/core';
import { classes } from '@trinity/kit/utils';

@Directive({
	selector: '[trnCardContent]',
	host: { 'data-slot': 'card-content' },
})
export class TrnCardContent {
	constructor() {
		classes(() => 'px-(--card-spacing)');
	}
}
