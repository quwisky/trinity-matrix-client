import {
  computed,
  Directive,
  effect,
  inject,
  input,
  model,
  signal,
  type Signal,
} from '@angular/core';
import { BrnTabs } from '@spartan-ng/brain/tabs';
import type { TrnTabsAppearance } from './trn-tabs-recipe';

export type { TrnTabsAppearance };

/** What the root reads of each tab in the list. */
interface TrnTabState {
  value(): string;
  readonly disabled: boolean;
}

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

  private readonly listed = signal<Signal<readonly TrnTabState[]>>(signal([]));
  private readonly values = computed(() =>
    this.listed()().map((tab) => tab.value()),
  );
  private readonly enabled = computed(() =>
    this.listed()()
      .filter((tab) => !tab.disabled)
      .map((tab) => tab.value()),
  );

  /** The tab holding focus inside the list; null while focus is elsewhere. */
  readonly focused = signal<string | null>(null);
  /**
   * The list's single tab stop: the focused tab, else the selected one, else the first enabled
   * one, so Tab always reaches the list.
   */
  readonly tabStop = computed(() => {
    const enabled = this.enabled();
    const focused = this.focused();
    const value = this.value();
    if (focused !== null && enabled.includes(focused)) return focused;
    if (value !== undefined && enabled.includes(value)) return value;
    return enabled[0] ?? null;
  });
  readonly direction = this.brn.direction;

  readonly value = model<string>();
  readonly appearance = input<TrnTabsAppearance>('segmented');

  constructor() {
    this.brn.activeTab.subscribe((tab) => {
      if (tab !== undefined) {
        this.value.set(tab);
      }
    });
    effect(() => this.brn.activeTab.set(this.value()));
  }

  /** Called by the list with its live tabs; an empty list when it goes. */
  connect(tabs: Signal<readonly TrnTabState[]>): void {
    this.listed.set(tabs);
  }

  /** Whether a tab for `tab` is shown; a panel without one is plain content. */
  hasTab(tab: string): boolean {
    return this.values().includes(tab);
  }

  tabId(tab: string): string {
    return `${this.id}-tab-${tab}`;
  }

  panelId(tab: string): string {
    return `${this.id}-panel-${tab}`;
  }
}
