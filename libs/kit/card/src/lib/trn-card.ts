import { Directive, input } from '@angular/core';
import { classes } from '@trinity/kit/utils';
import { TrnCardConfig, injectTrnCardConfig } from './trn-card.token';

@Directive({
	selector: '[trnCard],trn-card',
	host: {
		'data-slot': 'card',
		'[attr.data-size]': 'size()',
	},
})
export class TrnCard {
	private readonly _defaultConfig = injectTrnCardConfig();
	public readonly size = input<TrnCardConfig['size']>(this._defaultConfig.size);

	constructor() {
		classes(() => 'ring-foreground/10 bg-card text-card-foreground gap-(--card-spacing) overflow-hidden rounded-xl py-(--card-spacing) text-sm ring-1 [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl group/card flex flex-col');
	}
}
