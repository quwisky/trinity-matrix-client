import { BooleanInput } from '@angular/cdk/coercion';
import { booleanAttribute, ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { BrnSelectContent } from '@spartan-ng/brain/select';
import { classes, hlm } from '@trinity/helm/utils';
import { HlmSelectScrollDown } from './hlm-select-scroll-down';
import { HlmSelectScrollUp } from './hlm-select-scroll-up';

/**
 * ┌─ VENDORED FILE — @spartan-ng/cli generated, then diverged ────────────────────────────┐
 *
 * Two deliberate local overrides.
 *
 * 1. Both `animate-in` / `animate-out` triggers carry `motion-safe:`, matching
 *    `hlm-dropdown-menu`. Upstream ships them bare, which left this panel's reduced-motion
 *    behaviour resting entirely on the blanket `!important` reset in
 *    `apps/trinity/src/global.scss`. Pinned by scripts/kit-reduced-motion.spec.mjs.
 *
 * 2. Every `hostDirectives` entry states its `inputs` and
 * `outputs` explicitly, even when both are empty. `hostDirectives` is public API — a
 * composed directive's input or output is bindable on our element only if the entry lists
 * it — so the generator's shorthand form makes that decision by omission. It hid a real
 * defect once: `HlmInput` composed `BrnFieldControlDescribedBy` without listing
 * `aria-describedby`, so the attribute was silently overwritten with null (#153).
 *
 * A regenerate drops this and restores the shorthand. `scripts/host-directives.spec.mjs`
 * fails when it does, rather than letting it ship. See "Registered vendored divergences"
 * in docs/architecture/ui-and-theming.md.
 * └──────────────────────────────────────────────────────────────────────────────────────┘
 */

@Component({
	selector: 'hlm-select-content',
	imports: [HlmSelectScrollUp, HlmSelectScrollDown],
	changeDetection: ChangeDetectionStrategy.OnPush,
	hostDirectives: [
    { directive: BrnSelectContent, inputs: [], outputs: [] },
  ],
	template: `
		@if (showScroll()) {
			<hlm-select-scroll-up />
		}

		<div role="listbox" [class]="_computedListboxClasses()">
			<ng-content />
		</div>

		@if (showScroll()) {
			<hlm-select-scroll-down />
		}
	`,
})
export class HlmSelectContent {
	protected readonly _computedListboxClasses = computed(() => hlm('flex flex-col'));

	public readonly showScroll = input<boolean, BooleanInput>(false, { transform: booleanAttribute });

	constructor() {
		classes(() => 'bg-popover no-scrollbar text-popover-foreground motion-safe:data-open:animate-in motion-safe:data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 max-h-72 min-w-36 flex-col rounded-lg shadow-md ring-1 duration-100 relative flex w-(--brn-select-width) overflow-x-hidden overflow-y-auto');
	}
}
