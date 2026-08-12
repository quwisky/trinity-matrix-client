import { Directive } from '@angular/core';
import { classes } from '@trinity/kit/utils';

@Directive({
	selector: '[trnCardFooter],trn-card-footer',
	host: { 'data-slot': 'card-footer' },
})
export class TrnCardFooter {
	constructor() {
		classes(() => 'bg-muted/50 rounded-b-xl border-t p-(--card-spacing) flex items-center');
	}
}
