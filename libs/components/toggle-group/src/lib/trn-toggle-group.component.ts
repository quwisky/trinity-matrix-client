import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  contentChildren,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { HlmToggleGroup } from '@trinity/helm/toggle-group';
import { TrnToggleGroupItemDirective } from './trn-toggle-group-item.directive';

/**
 * A group of toggle buttons — a formatting bar, a view switcher, a segmented control.
 *
 * ## Why this wrapper carries keyboard behaviour, unlike its neighbours
 *
 * The rest of this tier is a thin re-publication of the kit's surface. This one is not,
 * because the kit's primitive is a **value holder, not a toolbar**: `BrnToggleGroup` gives
 * `role="group"`, selection state and a `ControlValueAccessor`, and there is no keydown
 * handling anywhere in it. Rendered as-is, a nine-button bar puts nine stops in the tab
 * order — the thing a toolbar exists to avoid, and a WCAG 2.4.3 problem rather than a
 * nicety. Roving tabindex is therefore added here, once, instead of at each call site.
 *
 * `role="toolbar"` for the same reason: it is what tells a screen reader that the arrow keys
 * move between these buttons, and it is only honest once they actually do. Bound rather than
 * written as a static attribute, deliberately — `BrnToggleGroup` contributes a static
 * `role="group"` from its own host metadata, and two static attributes on one element resolve
 * by an application order nobody should have to depend on. A binding always wins.
 *
 * Arrow keys move along the group's orientation, Home and End go to the ends, and a disabled
 * item is skipped rather than focused-and-inert. Selection stays the kit's job — this moves
 * focus, it does not press anything.
 */
@Component({
  selector: 'trn-toggle-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Only what HlmToggleGroup DECLARES is listed. `type`, `value`, `nullable`, `disabled` and
  // `valueChange` are absent on purpose and are not lost: Angular re-publishes a host
  // directive's inputs one level only, so listing them here throws NG0311 — but HlmToggleGroup
  // already publishes them onto this same host element from BrnToggleGroup, so a call site
  // binds them on `<trn-toggle-group>` exactly as if they were declared here.
  hostDirectives: [
    {
      directive: HlmToggleGroup,
      inputs: ['variant', 'size', 'spacing', 'orientation'],
      outputs: [],
    },
  ],
  host: {
    '[attr.role]': '"toolbar"',
    '[attr.aria-orientation]': 'group.orientation()',
    '(keydown)': 'onKeydown($event)',
  },
  template: '<ng-content />',
})
export class TrnToggleGroupComponent {
  /**
   * The kit directive on this same element, injected so its `orientation` can be READ.
   *
   * `orientation` is re-published above rather than re-declared here, and the difference is
   * not cosmetic: the kit drives `[attr.data-orientation]` and its own
   * `data-vertical:flex-col` classes from that signal, so a second input declared on this
   * class would have left the kit's at its default — a bar laid out as a row while announcing
   * itself as a column, with the arrow keys following the announcement rather than the
   * layout. One input, one source of truth, read from the directive that owns it.
   */
  protected readonly group = inject(HlmToggleGroup);

  private readonly items = contentChildren(TrnToggleGroupItemDirective);

  constructor() {
    // Keyed on the ITEM SET, not on the first render. A contextual bar's buttons live behind
    // `@if`, so the set changes while the group is alive — and seeding once meant that
    // removing whichever item held the stop left every button at -1 and the whole toolbar
    // unreachable by Tab, which is the exact failure the roving tabindex exists to prevent.
    effect(() => {
      const items = this.items();
      untracked(() => this.ensureTabStop(items));
    });

    // The other way the holder can go: it stays in the set and simply becomes disabled, which
    // is not a signal this component reads and so moves nothing above. The browser stops
    // focusing it while it keeps its `tabIndex`, leaving the group with no reachable button —
    // the same dead end as losing the item outright, reached by a different route. Watching
    // the attribute is the only honest way to hear about it, since the flag belongs to
    // `BrnToggleGroupItem` and arrives as a host binding rather than through this API.
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    if (typeof MutationObserver !== 'undefined') {
      const watcher = new MutationObserver(() =>
        this.ensureTabStop(this.items()),
      );
      watcher.observe(host, {
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled'],
      });
      inject(DestroyRef).onDestroy(() => watcher.disconnect());
    }
  }

  /** Put the one tab stop back if nothing usable holds it. */
  private ensureTabStop(items: readonly TrnToggleGroupItemDirective[]): void {
    if (!items.some((item) => this.isTabStop(item))) {
      this.setTabStop(this.firstEnabled());
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    const next = this.destination(event.key);
    if (next === undefined) {
      return;
    }
    event.preventDefault(); // arrows would otherwise scroll whatever the bar sits in
    this.setTabStop(next);
    next.element.focus();
  }

  /** Which item a key means, or undefined for a key this bar does not handle. */
  private destination(key: string): TrnToggleGroupItemDirective | undefined {
    const enabled = this.enabledItems();
    if (!enabled.length) {
      return undefined;
    }
    const [back, forward] =
      this.group.orientation() === 'vertical'
        ? ['ArrowUp', 'ArrowDown']
        : ['ArrowLeft', 'ArrowRight'];
    // From the FOCUSED item, not a remembered index: focus can also arrive by click or by
    // Tab, and an index that only moves on arrow presses would then jump somewhere else.
    const at = enabled.findIndex(
      (item) => item.element === document.activeElement,
    );
    switch (key) {
      case back:
        // Wraps, as a toolbar does — there is no "before the first" to fall off.
        return enabled[(Math.max(at, 0) - 1 + enabled.length) % enabled.length];
      case forward:
        return enabled[(at + 1) % enabled.length];
      case 'Home':
        return enabled[0];
      case 'End':
        return enabled[enabled.length - 1];
      default:
        return undefined;
    }
  }

  /**
   * Which items a key may land on.
   *
   * Read off the rendered attribute rather than a signal of our own, because
   * `BrnToggleGroupItem` binds `[attr.disabled]` from a value that already folds in the
   * GROUP's disabled as well as the item's — a wrapper-owned flag would miss half of it. The
   * cost is a dependency on that vendor host binding keeping its name, which
   * `trn-toggle-group.component.spec.ts` pins.
   */
  private enabledItems(): readonly TrnToggleGroupItemDirective[] {
    return this.items().filter(
      (item) => !item.element.hasAttribute('disabled'),
    );
  }

  private firstEnabled(): TrnToggleGroupItemDirective | undefined {
    return this.enabledItems()[0];
  }

  /**
   * Whether this item is the one tab stop, and can still be used as it.
   *
   * The disabled half matters: an item that held the stop and then became disabled keeps its
   * `tabIndex` while the browser stops focusing it, so treating it as the holder would leave
   * the group with no reachable button at all.
   */
  private isTabStop(item: TrnToggleGroupItemDirective): boolean {
    return (
      item.element.tabIndex === 0 && !item.element.hasAttribute('disabled')
    );
  }

  /** Exactly one item is tabbable at a time; that is the whole of roving tabindex. */
  private setTabStop(active: TrnToggleGroupItemDirective | undefined): void {
    for (const item of this.items()) {
      item.element.tabIndex = item === active ? 0 : -1;
    }
  }
}
