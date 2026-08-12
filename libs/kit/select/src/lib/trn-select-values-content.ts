import { Directive } from '@angular/core';
import { classes } from '@trinity/kit/utils';

@Directive({ selector: '[trnSelectValuesContent],trn-select-values-content' })
export class TrnSelectValuesContent {
	constructor() {
		classes(() => 'gap-2 flex');
	}
}
