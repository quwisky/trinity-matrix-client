import { Directive, ElementRef, inject } from '@angular/core';
import { HlmToggleGroupItem } from '@trinity/helm/toggle-group';

/**
 * One button in a {@link TrnToggleGroupComponent}.
 *
 * Nothing is listed for re-publication, and `value`/`disabled` are still bindable on the
 * button: Angular re-publishes a host directive's inputs one level only, so naming them here
 * throws NG0311, while HlmToggleGroupItem already publishes them onto this same host element
 * from BrnToggleGroupItem.
 *
 * `variant` and `size` are left off, so an item falls back to HlmToggleGroupItem's own
 * defaults unless the group sets them — which is how a bar stays visually of a piece without
 * this having to enforce anything. Nothing stops a caller reaching for the kit's names on the
 * button; the tier's boundary is what it can IMPORT, not what it can type.
 *
 * `aria-label` stays the caller's own binding rather than something this re-publishes, so a
 * call site labels one of these buttons the way it labels every other button.
 */
@Directive({
  selector: 'button[trnToggleGroupItem]',
  hostDirectives: [
    {
      directive: HlmToggleGroupItem,
      inputs: [],
      outputs: [],
    },
  ],
  host: {
    // Roving tabindex: the group hands exactly one item a stop in the tab order and moves it
    // with the arrow keys. Seeded to -1 so a group renders with none until the group says
    // otherwise — the group sets its first enabled item on init, and a seed of 0 here would
    // briefly put every button in the tab order on the first render.
    tabindex: '-1',
  },
})
export class TrnToggleGroupItemDirective {
  /**
   * The button itself, for the group to move focus and the tab stop with.
   *
   * Public because the group is a separate class and has no other way to reach it — not an
   * invitation. Nothing outside {@link TrnToggleGroupComponent} should be reading it: a
   * consumer holding this holds the DOM node this tier exists to keep out of call sites.
   */
  readonly element: HTMLElement =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
}
