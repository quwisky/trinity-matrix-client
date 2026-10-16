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

// Message search's server-search banner: a lone action, its message slot unused.
@Component({
  imports: [BannerComponent],
  template: `
    <trn-banner>
      @if (withMessage) {
        <span>Showing server results.</span>
      } @else {
        <span trnBannerActions><button>Search all messages</button></span>
      }
    </trn-banner>
  `,
})
class ActionOnlyHostComponent {
  withMessage = false;
}

@Component({
  imports: [BannerComponent],
  template: `
    <trn-banner>
      @if (withMessage) {
        <span>Showing server results.</span>
      } @else {
        <span trnBannerActions><button>Search all messages</button></span>
      }
    </trn-banner>
  `,
})
class ServerSummaryHostComponent {
  withMessage = true;
}

@Component({
  imports: [BannerComponent],
  template: `<trn-banner>Reconnecting…</trn-banner>`,
})
class MessageOnlyHostComponent {}

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

  // The stylesheet hides empty slots with :empty so they take no basis or gap (#1221).
  it('leaves the icon and message slots empty for a lone action', async () => {
    const actionOnly = await render(ActionOnlyHostComponent);
    expect(
      actionOnly.container.querySelector('.banner__text')?.matches(':empty'),
    ).toBe(true);
    expect(
      actionOnly.container.querySelector('.banner__icon')?.matches(':empty'),
    ).toBe(true);
    expect(
      actionOnly.container.querySelector('.banner__actions')?.matches(':empty'),
    ).toBe(false);
    // The @else branch's single root lands in the actions slot, not the message slot.
    expect(
      actionOnly.container.querySelector(
        '.banner__actions > [trnBannerActions]',
      ),
    ).not.toBeNull();
  });

  it('routes the @if branch message into the message slot', async () => {
    const summary = await render(ServerSummaryHostComponent);
    expect(
      summary.container.querySelector('.banner__text')?.textContent?.trim(),
    ).toBe('Showing server results.');
    expect(
      summary.container.querySelector('.banner__actions')?.matches(':empty'),
    ).toBe(true);
  });

  it('leaves the actions slot empty when there are no actions', async () => {
    const messageOnly = await render(MessageOnlyHostComponent);
    expect(
      messageOnly.container
        .querySelector('.banner__actions')
        ?.matches(':empty'),
    ).toBe(true);
    expect(
      messageOnly.container.querySelector('.banner__text')?.matches(':empty'),
    ).toBe(false);
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

  // Banners in one shared slot replace each other; where the slot is narrow they keep one
  // reserved height (the stylesheet), so a replacement never moves the page.
  it('marks a banner that holds the global slot, and only that one', async () => {
    const { fixture, container } = await render(BannerComponent);
    const banner = () => container.querySelector('.banner');
    expect(banner()?.getAttribute('data-placement')).toBe('inline');

    fixture.componentRef.setInput('placement', 'global');
    fixture.detectChanges();
    expect(banner()?.getAttribute('data-placement')).toBe('global');
    // The host is the size container the reservation measures the slot width with.
    expect(fixture.nativeElement.getAttribute('data-placement')).toBe('global');
  });
});
