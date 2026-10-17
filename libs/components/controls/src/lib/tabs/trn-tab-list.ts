import { contentChildren, Directive, ElementRef, inject } from '@angular/core';
import { Directionality } from '@angular/cdk/bidi';
import { classes } from '@trinity/helm/utils';
import { trnTabListRecipe } from './trn-tabs-recipe';
import { TrnTab } from './trn-tab';
import { TrnTabs } from './trn-tabs';

/**
 * The row of `trnTab` buttons. The caller names it with `aria-label` or `aria-labelledby`.
 *
 * Not brain's tab list: its key manager keeps the tabs it found first, so a tab added later
 * could not be reached with the arrow keys.
 */
@Directive({
  selector: '[trnTabList]',
  host: {
    role: 'tablist',
    'aria-orientation': 'horizontal',
    '(keydown)': 'onKeydown($event)',
    '(focusin)': 'onFocusIn($event)',
    '(focusout)': 'onFocusOut($event)',
  },
})
export class TrnTabList {
  private readonly root = inject(TrnTabs);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly tabs = contentChildren(TrnTab, { descendants: true });
  private readonly direction = inject(Directionality).valueSignal;

  constructor() {
    classes(() => trnTabListRecipe());
  }

  protected onKeydown(event: KeyboardEvent): void {
    const tab = this.tabFor(event.target);
    if (!tab) {
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      // Selected here rather than by the button's synthesised click, so a held key selects
      // once whatever the host does with repeated clicks.
      event.preventDefault();
      tab.activate();
      return;
    }
    const target = this.targetFor(event.key, tab);
    if (target) {
      event.preventDefault();
      target.focus();
    }
  }

  protected onFocusIn(event: FocusEvent): void {
    this.root.focused.set(this.tabFor(event.target)?.value() ?? null);
  }

  protected onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !this.host.nativeElement.contains(next)) {
      this.root.focused.set(null);
    }
  }

  /** Where `key` moves from `from`, wrapping at both ends and skipping disabled tabs. */
  private targetFor(key: string, from: TrnTab): TrnTab | undefined {
    const enabled = this.tabs().filter((tab) => !tab.disabled);
    const forward = this.direction() === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const back = forward === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight';
    const index = enabled.indexOf(from);
    switch (key) {
      case forward:
        return enabled[(index + 1) % enabled.length];
      case back:
        return enabled[(index - 1 + enabled.length) % enabled.length];
      case 'Home':
        return enabled[0];
      case 'End':
        return enabled.at(-1);
      default:
        return undefined;
    }
  }

  private tabFor(target: EventTarget | null): TrnTab | undefined {
    return target instanceof Node
      ? this.tabs().find((tab) => tab.element.contains(target))
      : undefined;
  }
}
