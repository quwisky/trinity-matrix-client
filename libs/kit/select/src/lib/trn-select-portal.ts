import { Directive } from '@angular/core';
import { BrnPopoverContent } from '@spartan-ng/brain/popover';

@Directive({
	selector: '[trnSelectPortal]',
	hostDirectives: [{ directive: BrnPopoverContent, inputs: ['context', 'class'] , outputs: [] }],
})
export class TrnSelectPortal {}
