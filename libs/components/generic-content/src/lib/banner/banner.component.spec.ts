import { Component } from '@angular/core';
import { render } from '@trinity/testing';
import { BannerComponent } from './banner.component';

@Component({
  imports: [BannerComponent],
  template: `
    <trn-banner [variant]="variant">
      <span trnBannerIcon class="icon">i</span>
      Hello there
      <span trnBannerActions><button>Do it</button></span>
    </trn-banner>
  `,
})
class HostComponent {
  variant: 'neutral' | 'accent' = 'neutral';
}

describe('BannerComponent', () => {
  it('projects the icon, message, and actions into their slots', async () => {
    const { container } = await render(HostComponent);

    expect(container.querySelector('.banner__icon .icon')).toBeTruthy();
    expect(container.querySelector('.banner__text')?.textContent?.trim()).toBe(
      'Hello there',
    );
    // The banner is presentational only — announcement is the consumer's job (a
    // persistent sr-only live region), so the banner itself has no role="status".
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(
      container.querySelector('.banner__actions button')?.textContent?.trim(),
    ).toBe('Do it');
  });

  it('reflects the canonical variant', async () => {
    const { fixture, container } = await render(BannerComponent);
    const banner = () => container.querySelector('.banner');
    expect(banner()?.getAttribute('data-variant')).toBe('neutral');

    fixture.componentRef.setInput('variant', 'accent');
    fixture.detectChanges();
    expect(banner()?.getAttribute('data-variant')).toBe('accent');
  });

  it('declares the attention surface for its actions only in the accent tone', async () => {
    const { fixture, container } = await render(BannerComponent);
    const banner = () => container.querySelector('.banner');
    // Neutral paints a status surface; a solid button keeps its accent fill there.
    expect(banner()?.hasAttribute('data-trn-surface')).toBe(false);

    // Accent paints the attention surface, the same colour as a solid primary fill, so it
    // tells trnBtn to use the on-attention action roles instead (#1217).
    fixture.componentRef.setInput('variant', 'accent');
    fixture.detectChanges();
    expect(banner()?.getAttribute('data-trn-surface')).toBe('attention');
  });
});
