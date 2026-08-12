import { Directive } from '@angular/core';
import { BrnSelectGroup } from '@spartan-ng/brain/select';
import { classes } from '@trinity/kit/utils';

/**
 * ┌─ VENDORED FILE — @spartan-ng/cli generated, then diverged ────────────────────────────┐
 *
 * One deliberate local override: every `hostDirectives` entry states its `inputs` and
 * `outputs` explicitly, even when both are empty. `hostDirectives` is public API — a
 * composed directive's input or output is bindable on our element only if the entry lists
 * it — so the generator's shorthand form makes that decision by omission. It hid a real
 * defect once: `TrnInput` composed `BrnFieldControlDescribedBy` without listing
 * `aria-describedby`, so the attribute was silently overwritten with null (#153).
 *
 * A regenerate drops this and restores the shorthand. `scripts/host-directives.spec.mjs`
 * fails when it does, rather than letting it ship. See "Registered vendored divergences"
 * in docs/architecture/ui-and-theming.md.
 * └──────────────────────────────────────────────────────────────────────────────────────┘
 */

@Directive({
	selector: '[trnSelectGroup],trn-select-group',
	hostDirectives: [{ directive: BrnSelectGroup, inputs: [], outputs: [] },
  ],
	host: { 'data-slot': 'select-group' },
})
export class TrnSelectGroup {
	constructor() {
		classes(() => 'scroll-my-1 p-1');
	}
}
