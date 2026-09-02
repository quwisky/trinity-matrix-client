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
});
