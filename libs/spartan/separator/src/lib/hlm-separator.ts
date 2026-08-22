import { Directive } from '@angular/core';
import { BrnSeparator } from '@spartan-ng/brain/separator';
import { classes } from '@trinity/helm/utils';

export const hlmSeparatorClass =
	'inline-flex shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch';

@Directive({
	selector: '[hlmSeparator],hlm-separator',
	// `outputs: []` stated rather than omitted, as every other vendored entry in this kit
	// states it: Angular validates and merges inputs and outputs through the same code, so an
	// unstated `outputs` swallows a composed directive's output the way an unstated `inputs`
	// once swallowed `aria-describedby`. The CLI does not generate it; `host-directives.spec.mjs`
	// is what notices. BrnSeparator has none today, which is what makes the empty list honest.
	hostDirectives: [
		{ directive: BrnSeparator, inputs: ['orientation', 'decorative'], outputs: [] },
	],
	host: {
		'data-slot': 'separator',
	},
})
export class HlmSeparator {
	constructor() {
		classes(() => hlmSeparatorClass);
	}
}
