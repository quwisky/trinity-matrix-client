import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import type { TrnVariant } from '@trinity/components/foundations';

export type TrnBannerVariant = Extract<TrnVariant, 'neutral' | 'accent'>;

/**
 * `inline`: a banner in its own place in the page. `global`: one of several banners that
 * take turns in a single slot, each replacing the last as the state behind it changes.
 */
export type TrnBannerPlacement = 'inline' | 'global';

/**
 * The slim shell banner shared by the connectivity and encryption prompts: a
 * semantically coloured bar with a leading icon, a live-region message, and optional
 * trailing actions. Everything is projected, so the consumer owns the icon,
 * copy, and any buttons; this component only supplies the layout + tone.
 *
 * Render the `trnBannerActions` element only when it has content: an empty slot collapses,
 * but an element that renders no buttons still takes a gap at the end of the row.
 *
 * ```html
 * <trn-banner variant="accent">
 *   <trn-icon trnBannerIcon name="lock" />
 *   Set up encryption to secure your messages.
 *   <span trnBannerActions>
 *     <button trnBtn size="sm">Set up</button>
 *   </span>
 * </trn-banner>
 * ```
 */
@Component({
  selector: 'trn-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './banner.component.scss',
  templateUrl: './banner.component.html',
  host: { '[attr.data-placement]': 'placement()' },
})
export class BannerComponent {
  /** Semantic treatment: `neutral` status or `accent` call-to-action. */
  readonly variant = input<TrnBannerVariant>('neutral');

  /**
   * Where the slot is narrow enough for a two-action banner to wrap its actions under the
   * message, a `global` banner keeps that two-row height whichever banner holds the slot:
   * replacing one with another then never moves the page below it.
   */
  readonly placement = input<TrnBannerPlacement>('inline');

  /**
   * The accent tone paints the attention surface, so it declares that context for the
   * projected actions: `trnBtn` reads `data-trn-surface="attention"` and inverts its solid
   * fill, which would otherwise be the same accent as the banner.
   */
  protected readonly surface = computed(() =>
    this.variant() === 'accent' ? 'attention' : null,
  );
}
