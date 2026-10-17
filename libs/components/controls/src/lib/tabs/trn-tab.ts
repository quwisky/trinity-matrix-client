import { computed, Directive, ElementRef, inject } from '@angular/core';
import { BrnTabsTrigger } from '@spartan-ng/brain/tabs';
import { classes } from '@trinity/helm/utils';
import { trnTabRecipe } from './trn-tabs-recipe';
import { TrnTabs } from './trn-tabs';

/**
 * One tab in a `trnTabList`; `[trnTab]` is the value it selects. A disabled tab is skipped by
 * the arrow keys and left out of the tab order (the WAI-ARIA pattern allows either).
 */
@Directive({
  selector: 'button[trnTab]',
  exportAs: 'trnTab',
  hostDirectives: [
    {
      directive: BrnTabsTrigger,
      inputs: ['brnTabsTrigger: trnTab', 'disabled'],
      outputs: [],
    },
  ],
  // These outrank brain's own bindings, which host directives run first. Brain keeps the tab
  // stop on the selected tab even while manual activation moves focus elsewhere.
  host: {
    '[id]': 'root.tabId(value())',
    '[attr.aria-controls]': 'root.panelId(value())',
    '[tabindex]': 'tabIndex()',
  },
})
export class TrnTab {
  private readonly trigger = inject(BrnTabsTrigger);

  protected readonly root = inject(TrnTabs);
  protected readonly tabIndex = computed(() =>
    !this.trigger.disabled && this.root.tabStop() === this.value() ? 0 : -1,
  );

  readonly element =
    inject<ElementRef<HTMLButtonElement>>(ElementRef).nativeElement;
  readonly value = computed(() => this.trigger.triggerFor());

  constructor() {
    classes(() => trnTabRecipe());
  }

  get disabled(): boolean {
    return this.trigger.disabled;
  }

  /** Focuses the tab; with automatic activation that also selects it. */
  focus(): void {
    this.trigger.focus();
  }

  activate(): void {
    this.trigger.activate();
  }
}
