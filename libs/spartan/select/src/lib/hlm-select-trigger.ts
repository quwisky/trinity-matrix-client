import type { BooleanInput } from '@angular/cdk/coercion';
import { booleanAttribute, ChangeDetectionStrategy, Component, computed, Directive, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown } from '@ng-icons/lucide';
import { BrnFieldControlDescribedBy } from '@spartan-ng/brain/field';
import { BrnSelectTrigger } from '@spartan-ng/brain/select';
import { hlm } from '@trinity/helm/utils';
import type { ClassValue } from 'clsx';

/**
 * ┌─ VENDORED FILE — @spartan-ng/cli generated, then diverged ───────────────┐
 *
 * Trinity forwards `aria-labelledby` and explicit invalid state through this
 * wrapper to the inner combobox button, and gives that button the shared
 * coarse-pointer target floor. Upstream exposes no input for that focusable
 * element, so either attribute placed on `hlm-select-trigger` lands on a
 * role-less host instead.
 *
 * The override is registered in the developer UI and theming guide and pinned
 * by the public select wrapper test.
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/**
 * Runs after Brain's own host binding so an explicit invalid state is announced.
 *
 * `BrnSelectTrigger.forceInvalid` styles the trigger through
 * `data-matches-spartan-invalid` but does not include that override in its
 * `aria-invalid` computation. This private directive closes that mismatch without
 * exporting Brain's vocabulary through Trinity's public select.
 */
@Directive({
	selector: 'button[hlmSelectExplicitInvalid]',
	host: {
		'[attr.aria-invalid]': 'invalid() ? "true" : null',
	},
})
export class HlmSelectExplicitInvalid {
	readonly invalid = input(false, {
		alias: 'hlmSelectExplicitInvalid',
		transform: booleanAttribute,
	});
}

@Component({
	selector: 'hlm-select-trigger',
	imports: [
		NgIcon,
		BrnSelectTrigger,
		BrnFieldControlDescribedBy,
		HlmSelectExplicitInvalid,
	],
	providers: [provideIcons({ lucideChevronDown })],
	changeDetection: ChangeDetectionStrategy.OnPush,
	template: `
		<button
			brnSelectTrigger
			brnFieldControlDescribedBy
			[hlmSelectExplicitInvalid]="forceInvalid()"
			[forceInvalid]="forceInvalid()"
			[id]="buttonId()"
			[class]="_computedClass()"
			[attr.data-size]="size()"
			[attr.aria-labelledby]="ariaLabelledby()"
			data-slot="select-trigger"
		>
			<ng-content />
			<ng-icon name="lucideChevronDown" class="text-muted-foreground text-[length:--spacing(4)] ms-auto" />
		</button>
	`,
})
export class HlmSelectTrigger {
	private static _id = 0;

	public readonly userClass = input<ClassValue>('', { alias: 'class' });
	protected readonly _computedClass = computed(() =>
		hlm(
			'border-input text-[var(--trinity-text-bright)] data-placeholder:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50 focus-visible:border-ring focus-visible:ring-ring/50 data-[matches-spartan-invalid=true]:ring-destructive/20 dark:data-[matches-spartan-invalid=true]:ring-destructive/40 data-[matches-spartan-invalid=true]:border-destructive dark:data-[matches-spartan-invalid=true]:border-destructive/50 gap-1.5 rounded-lg border bg-transparent py-2 ps-2.5 pe-2 text-sm transition-colors focus-visible:ring-3 data-[matches-spartan-invalid=true]:ring-3 min-h-[max(var(--trinity-density-control-size),var(--trinity-interaction-target-min-size))] data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:gap-1.5 flex w-fit items-center justify-between whitespace-nowrap outline-none disabled:cursor-not-allowed disabled:opacity-50 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center [&_ng-icon]:pointer-events-none [&_ng-icon]:shrink-0',
			this.userClass(),
		),
	);

	public readonly buttonId = input<string>(`hlm-select-trigger-${HlmSelectTrigger._id++}`);

	/** Trinity override: names the inner combobox rather than this role-less host. */
	public readonly ariaLabelledby = input<string | null>(null, { alias: 'aria-labelledby' });

	public readonly size = input<'default' | 'sm'>('default');

	/** Whether to force the trigger into an invalid state. */
	public readonly forceInvalid = input<boolean, BooleanInput>(false, { transform: booleanAttribute });
}
