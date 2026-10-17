import {
  computed,
  Directive,
  effect,
  inject,
  model,
  signal,
} from '@angular/core';
import { BrnTabs } from '@spartan-ng/brain/tabs';

export type TrnTabsActivation = 'automatic' | 'manual';

let nextId = 0;

/**
 * Trinity's tabs: one `trnTabList` of `trnTab` buttons and one `trnTabPanel` per tab, all
 * inside this element. `[(value)]` is the selected tab. With `activation="automatic"` (the
 * default) moving focus between tabs also selects; with `"manual"` Enter, Space or a click
 * selects.
 */
@Directive({
  selector: '[trnTabs]',
  exportAs: 'trnTabs',
  hostDirectives: [
    {
      directive: BrnTabs,
      inputs: ['activationMode: activation'],
      outputs: [],
    },
  ],
})
export class TrnTabs {
  private readonly brn = inject(BrnTabs);
  /** Brain derives element ids from the tab value alone; this keeps two tab sets apart. */
  private readonly id = `trn-tabs-${nextId++}`;

  /** The tab holding focus inside the list; null while focus is elsewhere. */
  readonly focused = signal<string | null>(null);
  /** The tab holding the list's single tab stop: the focused one, else the selected one. */
  readonly tabStop = computed(() => this.focused() ?? this.value());

  readonly value = model<string>();

  constructor() {
    this.brn.activeTab.subscribe((tab) => {
      if (tab !== undefined) {
        this.value.set(tab);
      }
    });
    effect(() => this.brn.activeTab.set(this.value()));
  }

  tabId(tab: string): string {
    return `${this.id}-tab-${tab}`;
  }

  panelId(tab: string): string {
    return `${this.id}-panel-${tab}`;
  }
}
