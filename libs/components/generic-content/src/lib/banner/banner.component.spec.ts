import { Component } from '@angular/core';
import { render } from '@trinity/testing';
import { BannerComponent } from './banner.component';

@Component({
  imports: [BannerComponent],
  template: `
    <trn-banner [tone]="tone">
      <span trnBannerIcon class="icon">i</span>
      Hello there
      <span trnBannerActions><button>Do it</button></span>
    </trn-banner>
  `,
})
class HostComponent {
  tone: 'neutral' | 'accent' = 'neutral';
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

  it('reflects the canonical variant while retaining the legacy data hook', async () => {
    const { fixture, container } = await render(BannerComponent);
    const banner = () => container.querySelector('.banner');
    expect(banner()?.getAttribute('data-variant')).toBe('neutral');
    expect(banner()?.getAttribute('data-tone')).toBe('neutral');

    fixture.componentRef.setInput('variant', 'accent');
    fixture.detectChanges();
    expect(banner()?.getAttribute('data-variant')).toBe('accent');
    expect(banner()?.getAttribute('data-tone')).toBe('accent');
  });

  it('keeps the legacy tone input valid during expansion', async () => {
    const { fixture, container } = await render(BannerComponent, {
      inputs: { tone: 'accent' },
    });

    expect(
      container.querySelector('.banner')?.getAttribute('data-variant'),
    ).toBe('accent');

    fixture.componentRef.setInput('variant', 'neutral');
    fixture.detectChanges();
    expect(
      container.querySelector('.banner')?.getAttribute('data-variant'),
    ).toBe('neutral');
  });
});
