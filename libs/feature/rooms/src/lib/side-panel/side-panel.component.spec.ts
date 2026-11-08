import { Component } from '@angular/core';
import { render, screen } from '@trinity/testing';
import { provideTrnIcons } from '@trinity/components/foundations';
import { SidePanelComponent } from './side-panel.component';
import { SidePanelEmptyComponent } from './side-panel-empty.component';

@Component({
  imports: [SidePanelComponent],
  template: `
    <trn-side-panel
      heading="Search"
      subtitle="3 results"
      icon="search"
      closeLabel="Close search"
      (closed)="closed = true"
    >
      <input sidePanelStrip aria-label="Query" />
      <p>Row</p>
      <div sidePanelFooter>Composer</div>
    </trn-side-panel>
  `,
})
class FramedPanelComponent {
  closed = false;
}

describe('SidePanelComponent', () => {
  it('puts the header, the strip, the body and the footer in that order', async () => {
    const { container } = await render(FramedPanelComponent, {
      providers: [provideTrnIcons()],
    });
    const heading = screen.getByRole('heading', { name: 'Search 3 results' });
    const strip = container.querySelector('.side-panel__strip')!;
    const body = container.querySelector('.side-panel__body')!;
    const footer = screen.getByText('Composer');
    expect(strip.contains(screen.getByLabelText('Query'))).toBe(true);
    expect(body.contains(screen.getByText('Row'))).toBe(true);
    for (const [a, b] of [
      [heading, strip],
      [strip, body],
      [body, footer],
    ] as const) {
      expect(
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('closes through its header', async () => {
    const { fixture } = await render(FramedPanelComponent, {
      providers: [provideTrnIcons()],
    });
    screen.getByRole('button', { name: 'Close search' }).click();
    expect(fixture.componentInstance.closed).toBe(true);
  });

  it('scrolls its body unless the content is its own scroller', async () => {
    const { container, fixture } = await render(SidePanelComponent, {
      inputs: { heading: 'Thread', scroll: false },
      providers: [provideTrnIcons()],
    });
    const body = container.querySelector('.side-panel__body')!;
    expect(body.classList).not.toContain('side-panel__body--scroll');
    fixture.componentRef.setInput('scroll', true);
    fixture.detectChanges();
    expect(body.classList).toContain('side-panel__body--scroll');
  });

  it('shows three named skeleton rows in place of the body while loading', async () => {
    const panel = await render(SidePanelComponent, {
      inputs: {
        heading: 'Pinned',
        loading: true,
        loadingLabel: 'Loading pins',
      },
      providers: [provideTrnIcons()],
    });
    const loading = panel.container.querySelector(
      '[data-testid="side-panel-loading"]',
    )!;
    expect(loading.getAttribute('role')).toBe('status');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.getAttribute('aria-label')).toBe('Loading pins');
    expect(loading.textContent?.trim()).toBe('Loading pins');
    expect(loading.querySelectorAll('.side-panel__skeleton')).toHaveLength(3);
    expect(panel.container.querySelector('.side-panel__body--scroll')).toBe(
      loading,
    );
  });
});

describe('SidePanelEmptyComponent', () => {
  it('names the empty panel in a heading and explains it, as a status', async () => {
    const { container } = await render(SidePanelEmptyComponent, {
      inputs: { icon: 'pin', heading: 'No pins', body: 'Pin a message.' },
      providers: [provideTrnIcons()],
    });
    const host = container.querySelector('trn-side-panel-empty') ?? container;
    expect(
      screen.getByRole('heading', { level: 3, name: 'No pins' }),
    ).toBeTruthy();
    expect(screen.getByText('Pin a message.')).toBeTruthy();
    expect(
      host.querySelector('.side-panel-empty__ring trn-icon'),
    ).not.toBeNull();
  });
});
