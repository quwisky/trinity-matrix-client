import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { TrnVariant } from '@trinity/components/foundations';

export type TrnBannerVariant = Extract<TrnVariant, 'neutral' | 'accent'>;

/**
 * The slim shell banner shared by the connectivity and encryption prompts: a
 * semantically coloured bar with a leading icon, a live-region message, and optional
 * trailing actions. Everything is projected, so the consumer owns the icon,
 * copy, and any buttons; this component only supplies the layout + tone.
 *
 * ```html
 * <trn-banner variant="accent">
 *   <trn-icon trnBannerIcon name="lock" />
 *   Set up encryption to secure your messages.
 *   <span trnBannerActions>
 *     <button hlmBtn size="sm">Set up</button>
 *   </span>
 * </trn-banner>
 * ```
 */
@Component({
  selector: 'trn-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './banner.component.scss',
  templateUrl: './banner.component.html',
})
export class BannerComponent {
  /** Semantic treatment: `neutral` status or `accent` call-to-action. */
  readonly variant = input<TrnBannerVariant>('neutral');
}
