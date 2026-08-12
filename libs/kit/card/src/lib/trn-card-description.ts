import { Directive } from '@angular/core';
import { classes } from '@trinity/kit/utils';

@Directive({
	selector: '[trnCardDescription]',
	host: { 'data-slot': 'card-description' },
})
export class TrnCardDescription {
	constructor() {
		classes(() => 'text-muted-foreground text-sm');
	}
}
