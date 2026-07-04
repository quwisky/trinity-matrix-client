import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The slim shell banner shared by the connectivity and encryption prompts: a
 * tone-coloured bar with a leading icon, a live-region message, and optional
 * trailing actions. Everything is projected, so the consumer owns the icon,
 * copy, and any buttons; this component only supplies the layout + tone.
 *
 * ```html
 * <trn-banner tone="accent">
 *   <ng-icon trnBannerIcon name="lucideLock" aria-hidden="true" />
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
  template: `
    <div class="banner" [attr.data-tone]="tone()">
      <span class="banner__icon"><ng-content select="[trnBannerIcon]" /></span>
      <!-- Live region scoped to the message so trailing actions aren't read as
           part of the polite announcement. -->
      <span class="banner__text" role="status"><ng-content /></span>
      <span class="banner__actions"
        ><ng-content select="[trnBannerActions]"
      /></span>
    </div>
  `,
})
export class BannerComponent {
  /** Colour tone: `neutral` (passive status) or `accent` (call-to-action). */
  readonly tone = input<'neutral' | 'accent'>('neutral');
}
