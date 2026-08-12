import { Directive, inject } from '@angular/core';
import { BrnSelectValue } from '@spartan-ng/brain/select';
import { classes } from '@trinity/kit/utils';

@Directive({
	selector: '[trnSelectValue],trn-select-value',
	hostDirectives: [{ directive: BrnSelectValue, inputs: ['placeholder'] , outputs: [] }],
	host: { '[attr.data-slot]': '!_hidden() ? "select-value" : null' },
})
export class TrnSelectValue {
	private readonly _brnSelectValue = inject(BrnSelectValue);

	protected readonly _hidden = this._brnSelectValue.hidden;

	constructor() {
		classes(() => 'data-hidden:hidden');
	}
}
