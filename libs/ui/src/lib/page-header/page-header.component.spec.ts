import { Component } from '@angular/core';
import { render } from '@trinity/testing';
import { PageHeaderComponent } from './page-header.component';

@Component({
  imports: [PageHeaderComponent],
  template: `
    <trn-page-header [variant]="variant" [title]="title">
      <button trnHeaderLeading class="lead">Back</button>
      <span trnHeaderActions><button class="act">Close</button></span>
    </trn-page-header>
  `,
})
class TitleHostComponent {
  variant: 'page' | 'chat' = 'page';
  title: string | undefined = 'Settings';
}

@Component({
  imports: [PageHeaderComponent],
  template: `
    <trn-page-header variant="chat">
      <span trnHeaderTitle class="projected-title"># general</span>
    </trn-page-header>
  `,
})
class ProjectedTitleHostComponent {}

describe('PageHeaderComponent', () => {
  it('renders exactly one header and one h1, with the title input as the heading text', async () => {
    const { container } = await render(TitleHostComponent);

    expect(container.querySelectorAll('header')).toHaveLength(1);
    const headings = container.querySelectorAll('h1');
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent?.trim()).toBe('Settings');
  });

  it('projects the leading and actions slots', async () => {
    const { container } = await render(TitleHostComponent);

    expect(container.querySelector('.lead')?.textContent?.trim()).toBe('Back');
    expect(container.querySelector('.act')?.textContent?.trim()).toBe('Close');
  });

  it('falls back to the projected [trnHeaderTitle] inside the h1 when no title input is set', async () => {
    const { container } = await render(ProjectedTitleHostComponent);

    const h1 = container.querySelector('h1');
    expect(h1).toBeTruthy();
    // The projected title is the body of the single h1 — not a nested heading.
    expect(h1?.querySelector('.projected-title')?.textContent?.trim()).toBe(
      '# general',
    );
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('swaps host classes by variant', async () => {
    // Drive the component directly with setInput (like the banner tone test) so
    // toggling the signal input doesn't trip NG0100 via a host-field mutation.
    const { fixture, container } = await render(PageHeaderComponent, {
      inputs: { title: 'X' },
    });
    const header = () => container.querySelector('header')!;

    // page (default): safe-top + min-h-14, no chat background.
    expect(header().className).toContain('safe-top');
    expect(header().className).toContain('min-h-14');
    expect(header().className).not.toContain('bg-[var(--trinity-chat)]');

    fixture.componentRef.setInput('variant', 'chat');
    fixture.detectChanges();
    // chat: chat background, no safe-top, no min-h-14 (fixed h-14 instead).
    expect(header().className).toContain('bg-[var(--trinity-chat)]');
    expect(header().className).not.toContain('safe-top');
    expect(header().className).not.toContain('min-h-14');
    // The toolbar text color lives on the header (not just the h1) so the
    // resting ghost icon buttons inherit it, as the old .chat-toolbar rule did.
    expect(header().className).toContain('text-[var(--trinity-text-bright)]');
  });

  it('does not reflect the title input onto a native title attribute (no whole-bar tooltip)', async () => {
    const { container } = await render(TitleHostComponent);
    const host = container.querySelector('trn-page-header')!;
    expect(host.getAttribute('title')).toBeNull();
    expect(container.querySelector('header')!.getAttribute('title')).toBeNull();
  });
});
