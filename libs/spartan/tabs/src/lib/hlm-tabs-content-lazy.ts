import { Directive } from '@angular/core';
import { BrnTabsContentLazy } from '@spartan-ng/brain/tabs';

@Directive({
	selector: 'ng-template[hlmTabsContentLazy]',
	// Declared empty, not shorthand: `BrnTabsContentLazy` publishes neither an input nor an
	// output today, and stating both is how this kit records that someone checked.
	hostDirectives: [{ directive: BrnTabsContentLazy, inputs: [], outputs: [] }],
})
export class HlmTabsContentLazy {}
