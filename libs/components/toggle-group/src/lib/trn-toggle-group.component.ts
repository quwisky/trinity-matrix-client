import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  contentChildren,
  inject,
  input,
  Injector,
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
 * move between these buttons, and it is only honest once they actually do.
 *
 * Arrow keys move along `orientation`, Home and End go to the ends, and a disabled item is
 * skipped rather than focused-and-inert. Selection stays the kit's job — this moves focus,
 * it does not press anything.
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
      inputs: ['variant', 'size', 'spacing'],
      outputs: [],
    },
  ],
  host: {
    role: 'toolbar',
    '[attr.aria-orientation]': 'orientation()',
    '(keydown)': 'onKeydown($event)',
  },
  template: '<ng-content />',
})
export class TrnToggleGroupComponent {
  private readonly injector = inject(Injector);

  /**
   * Which way the buttons run, and therefore which arrows move between them.
   *
   * Declared here rather than re-published from the kit: this component reads it for the
   * keyboard mapping, and a re-published input is not readable from the wrapper that
   * publishes it.
   */
  readonly orientation = input<'horizontal' | 'vertical'>('horizontal');

  private readonly items = contentChildren(TrnToggleGroupItemDirective);

  constructor() {
    // One stop in the tab order from the first render, not from the first keypress: a bar
    // nobody has arrowed through yet still has to be reachable by Tab.
    afterNextRender(() => this.setTabStop(this.firstEnabled()), {
      injector: this.injector,
    });
  }

  protected onKeydown(event: KeyboardEvent): void {
    const next = this.destination(event.key);
    if (next === null) {
      return;
    }
    event.preventDefault(); // arrows would otherwise scroll whatever the bar sits in
    this.setTabStop(next);
    next?.element.focus();
  }

  /** Which item a key means, or null for a key this bar does not handle. */
  private destination(key: string): TrnToggleGroupItemDirective | null {
    const enabled = this.enabledItems();
    if (!enabled.length) {
      return null;
    }
    const [back, forward] =
      this.orientation() === 'vertical'
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
        return null;
    }
  }

  private enabledItems(): readonly TrnToggleGroupItemDirective[] {
    return this.items().filter(
      (item) => !item.element.hasAttribute('disabled'),
    );
  }

  private firstEnabled(): TrnToggleGroupItemDirective | undefined {
    return this.enabledItems()[0];
  }

  /** Exactly one item is tabbable at a time; that is the whole of roving tabindex. */
  private setTabStop(active: TrnToggleGroupItemDirective | undefined): void {
    for (const item of this.items()) {
      item.element.tabIndex = item === active ? 0 : -1;
    }
  }
}
