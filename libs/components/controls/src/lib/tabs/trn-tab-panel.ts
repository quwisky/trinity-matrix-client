import {
  booleanAttribute,
  computed,
  Directive,
  inject,
  input,
} from '@angular/core';
import { BrnTabsContent } from '@spartan-ng/brain/tabs';
import { TrnTabs } from './trn-tabs';

/**
 * The panel for the tab whose value is `[trnTabPanel]`; hidden while another is selected.
 * Without that tab in the list it is plain content, so a row can come and go around it.
 */
@Directive({
  selector: '[trnTabPanel]',
  exportAs: 'trnTabPanel',
  hostDirectives: [
    {
      directive: BrnTabsContent,
      inputs: ['brnTabsContent: trnTabPanel'],
      outputs: [],
    },
  ],
  host: {
    '[id]': 'root.panelId(value())',
    '[attr.role]': 'tabbed() ? "tabpanel" : null',
    '[attr.aria-labelledby]': 'tabbed() ? root.tabId(value()) : null',
    '[attr.tabindex]': 'tabbed() && focusable() ? 0 : null',
  },
})
export class TrnTabPanel {
  private readonly content = inject(BrnTabsContent);

  protected readonly root = inject(TrnTabs);
  protected readonly value = computed(() => this.content.contentFor());
  protected readonly tabbed = computed(() => this.root.hasTab(this.value()));

  /**
   * Whether the panel itself is a tab stop. Turn it off when the panel's first content is
   * focusable, so Tab from the list goes straight to it.
   */
  readonly focusable = input(true, { transform: booleanAttribute });
}
