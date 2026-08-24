import { Directive, input } from '@angular/core';
import { BrnTabsContent } from '@spartan-ng/brain/tabs';
import { classes } from '@trinity/helm/utils';

@Directive({
	selector: '[hlmTabsContent]',
	// `contentFor` is `BrnTabsContent`'s only published member — no outputs — so `outputs`
	// is empty by fact, not by omission.
	hostDirectives: [{ directive: BrnTabsContent, inputs: ['brnTabsContent: hlmTabsContent'], outputs: [] }],
	host: {
		'data-slot': 'tabs-content',
	},
})
export class HlmTabsContent {
	public readonly contentFor = input.required<string>({ alias: 'hlmTabsContent' });

	constructor() {
		classes(() => 'flex-1 text-sm outline-none');
	}
}
