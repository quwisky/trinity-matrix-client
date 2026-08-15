import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import type { TrnIconName } from '../trn-icon-name';

/**
 * Trinity's icon.
 *
 * **Decorative by default, announced only on request.** The inner `<ng-icon>` always
 * carries a *static* `aria-hidden="true"`, and a `label` moves the announcement to this
 * host instead. That split exists because of a trap in the vendor: `NgIcon` reads
 * `aria-hidden` through `HostAttributeToken` in its constructor and force-hides itself when
 * the attribute is absent — so a *bound* `[attr.aria-hidden]` is invisible to it, and an
 * `[attr.aria-label]` written beside one is announced to nobody. Trinity shipped exactly
 * that bug in the quick switcher. Here the static attribute is written once, in one file,
 * and call sites express intent with `label` instead of re-deriving the incantation.
 *
 * **Size goes through `size`, never through a `text-*` class on this element.** `HlmButton`'s
 * cva string carries `[&_ng-icon:not([class*='text-'])]:text-[length:--spacing(4)]`, whose
 * `:not()` is the opt-out an oversized icon used to rely on: the class sat on the `<ng-icon>`
 * itself, so the guard excluded it. Wrapping moved that class to THIS host and left the inner
 * `<ng-icon>` bare, which the guard therefore matches — the utility then writes `font-size`
 * straight onto the inner element, beating the size inherited from here, and `1em` resolves
 * against 16px instead of the intended 20px. `size` is immune because it sets
 * `--ng-icon__size`, which drives the inner element's own width/height rather than its
 * font-size. Verified in a browser, not in jsdom, which does no layout.
 */
@Component({
  selector: 'trn-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './trn-icon.component.html',
  imports: [NgIcon],
  styles: [
    // Matches the element this replaced. `ng-icon` sets `:host{display:inline-block}`, so
    // without this the wrapper is `display: inline` and every icon in the app changes box
    // model — harmless inside a flex parent, which blockifies its children, but in true
    // inline flow an inline host participates in baseline and line-height in a way the
    // inline-block element did not, and icons shift. `HlmSpinner` — the same shape, a
    // wrapper whose template is one `<ng-icon>` — declares `inline-flex` for this reason.
    //
    // It does so through `classes()` from @trinity/helm/utils, which is the kit's house
    // pattern and what this would otherwise use. A component style is deliberate here on
    // two counts: it ships with the component, so the box model does not depend on a
    // consuming app emitting the `inline-block` utility; and it is assertable, which a
    // Tailwind class is not, because jsdom loads no stylesheet. Switching to `classes()`
    // would silently make the box-model test in the spec vacuous — change both together
    // or neither. Keeping it also leaves this library importing nothing but @ng-icons.
    ':host { display: inline-block; }',
  ],
  host: {
    // Null rather than absent-when-false: an unlabelled icon must expose no role at all,
    // or every decorative icon becomes an announceable image with no name. An EMPTY label
    // counts as unlabelled for the same reason — `[attr.x]` only removes on null, so
    // passing '' would otherwise render `aria-label=""`: an announceable-looking element
    // with no name, which is the exact dead ARIA this component exists to prevent.
    '[attr.role]': 'announced() ? "img" : null',
    '[attr.aria-label]': 'announced()',
  },
})
export class TrnIconComponent {
  /** Which icon, from Trinity's own vocabulary — not a vendor identifier. */
  readonly name = input.required<TrnIconName>();
  /**
   * Accessible name. Leave unset for the common case: an icon sitting beside text that
   * already says the same thing, where a label is duplicate noise rather than help.
   */
  readonly label = input<string | null>(null);
  /**
   * Glyph size as a CSS length (`'1.25rem'`), forwarded to the inner element's
   * `--ng-icon__size`. Leave unset to keep inheriting from font-size, which is what the
   * ~100 icons sitting inside a button already do correctly. Set it — rather than reaching
   * for `class="text-xl"` — whenever an icon must be BIGGER than its context: see the note
   * above for why the class form silently stops working through this wrapper.
   *
   * `''` rather than `null` for "unset": `NgIcon.size` declares a `coerceCssPixelValue`
   * transform whose parameter is `string`, so a nullable input is an NG-template type error
   * under `strictTemplates` — caught by `pnpm build` and by nothing else. Empty behaves
   * identically at runtime; the coercion returns it untouched, Angular then drops the custom
   * property, and `1em` applies as before.
   */
  readonly size = input('');

  protected readonly announced = computed(() => this.label() || null);
}
