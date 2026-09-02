import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { HlmTabs, HlmTabsList, HlmTabsTrigger } from '@trinity/helm/tabs';
import {
  normalizeTrnTabsPresentation,
  normalizeTrnTabsVariant,
  type TrnTabsPresentation,
  type TrnTabsVariantInput,
} from './trn-tabs-recipe';

export type {
  TrnTabsPresentation,
  TrnTabsVariant,
  TrnTabsVariantInput,
} from './trn-tabs-recipe';

/** One tab in a {@link TrnTabsComponent}: the trigger, and the panel it reveals. */
export interface TrnTabOption {
  /** Matches the `value` of the {@link TrnTabPanelComponent} this tab shows. */
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
  /** For the Playwright harnesses, which drive these by id. */
  readonly testId?: string;
}

/**
 * A set of tabs: one panel visible at a time, chosen by a row of triggers.
 *
 * Thin, unlike {@link TrnToggleGroupComponent} next door, because `BrnTabs` already ships the
 * whole ARIA tab pattern — `role="tab"`/`"tablist"`/`"tabpanel"`, `aria-selected`,
 * `aria-controls`, `aria-labelledby`, a `FocusKeyManager` for the arrow keys, and
 * `type="button"` on every trigger so one inside a `<form>` cannot submit it. There is no
 * behaviour left to add; what this tier contributes is the name and the shape of the API.
 *
 * ```html
 * <trn-tabs tab="general" [tabs]="TABS" (tabActivated)="onTab($event)">
 *   <trn-tab-panel value="general">…</trn-tab-panel>
 *   <trn-tab-panel value="access">…</trn-tab-panel>
 * </trn-tabs>
 * ```
 *
 * ## Why the triggers are data and the panels are projected
 *
 * The asymmetry is forced, and it is worth writing down because the obvious symmetric design
 * does not work.
 *
 * A host directive's input can be re-published one level only. `HlmTabsTrigger` re-publishes
 * `BrnTabsTrigger`'s required `brnTabsTrigger` under the public name `hlmTabsTrigger`; a
 * `trn-*` directive composing `HlmTabsTrigger` can expose that name again, but it CANNOT
 * rename it — `inputs: ['hlmTabsTrigger: trnTab']` renames only `HlmTabsTrigger`'s own input
 * and leaves the brain directive's unbound, which fails at runtime with NG0950 rather than at
 * compile time. So a projected `<button trnTab="general">` is not achievable: the call site
 * would have to write the kit's own attribute name, which is the one thing this tier exists
 * to prevent.
 *
 * Rendering the triggers here instead sidesteps it — inside this template the kit's names are
 * ours to use — and it has to be *here* rather than in a projected `trn-tabs-list`, because
 * `BrnTabsList` finds its triggers with a content query, and a content query does not reach
 * into a child component's own view.
 *
 * Panels have no such query: `BrnTabsContent` registers itself with `BrnTabs` through DI,
 * which reaches up past a projection boundary. {@link TrnTabPanelComponent} therefore stays
 * a projected element, and panel content stays where it is written.
 *
 * Semantic treatment (`variant`) and structure (`presentation`) are independent.
 * The former `default` and `line` variant values remain temporary compatibility
 * inputs and normalize to neutral pill and neutral line recipes respectively.
 *
 * `tab` (the initially active one) is listed below and keeps its name for the same
 * one-level rule. `orientation`, `activationMode` and `(tabActivated)` are not listed and are
 * not lost — `HlmTabs` already publishes them onto this host element, so a call site binds
 * them on `<trn-tabs>` as if they were declared here.
 */
@Component({
  selector: 'trn-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTabsList, HlmTabsTrigger],
  hostDirectives: [{ directive: HlmTabs, inputs: ['tab'], outputs: [] }],
  template: `
    <hlm-tabs-list
      [variant]="resolvedPresentation() === 'pill' ? 'default' : 'line'"
      [attr.data-trn-variant]="resolvedVariant()"
      [attr.data-trn-presentation]="resolvedPresentation()"
    >
      @for (tab of tabs(); track tab.value) {
        <button
          [hlmTabsTrigger]="tab.value"
          [disabled]="tab.disabled ?? false"
          [attr.data-testid]="tab.testId"
          [class]="triggerToneClass()"
        >
          {{ tab.label }}
        </button>
      }
    </hlm-tabs-list>
    <ng-content />
  `,
})
export class TrnTabsComponent {
  readonly tabs = input.required<readonly TrnTabOption[]>();

  /** Semantic treatment. `default|line` remain temporary structural aliases. */
  readonly variant = input<TrnTabsVariantInput>('neutral');

  /** Filled pills or a line-marked navigation row. */
  readonly presentation = input<TrnTabsPresentation>('pill');

  protected readonly resolvedVariant = computed(() =>
    normalizeTrnTabsVariant(this.variant()),
  );

  protected readonly resolvedPresentation = computed(() =>
    normalizeTrnTabsPresentation(this.variant(), this.presentation()),
  );

  protected readonly triggerToneClass = computed(() =>
    this.resolvedVariant() === 'accent'
      ? 'data-active:bg-[var(--trinity-state-attention-surface)] data-active:text-[var(--trinity-state-attention-foreground)] group-data-[variant=line]/tabs-list:data-active:bg-transparent group-data-[variant=line]/tabs-list:data-active:text-[var(--trinity-link)] group-data-[variant=line]/tabs-list:data-active:after:bg-[var(--trinity-state-attention-surface)]'
      : '',
  );
}
