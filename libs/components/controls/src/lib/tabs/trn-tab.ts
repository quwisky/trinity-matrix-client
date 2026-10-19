import {
  afterRenderEffect,
  computed,
  Directive,
  ElementRef,
  inject,
  input,
} from '@angular/core';
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
  // Host directive bindings run first, so these win.
  host: {
    '[id]': 'root.tabId(value())',
    '[attr.aria-controls]': 'root.panelId(value())',
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
  /**
   * Also bound to brain's required trigger input. Read here without the required check: the
   * root reads every tab's value, and may do so before a newer tab's inputs are set.
   */
  readonly value = input('', { alias: 'trnTab' });

  constructor() {
    classes(() => trnTabRecipe(this.root.appearance()));
    // Not a host binding: brain binds `tabindex` to the selection and rewrites it whenever that
    // changes, so this has to run after it each time either does.
    afterRenderEffect(() => {
      this.trigger.selected();
      this.element.tabIndex = this.tabIndex();
    });
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
