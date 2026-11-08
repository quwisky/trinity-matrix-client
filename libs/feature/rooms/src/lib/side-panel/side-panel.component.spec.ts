import { Component } from '@angular/core';
import { render, screen } from '@trinity/testing';
import { provideTrnIcons } from '@trinity/components/foundations';
import { SidePanelComponent } from './side-panel.component';

@Component({
  imports: [SidePanelComponent],
  template: `
    <trn-side-panel
      title="Search"
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
      inputs: { title: 'Thread', scroll: false },
      providers: [provideTrnIcons()],
    });
    const body = container.querySelector('.side-panel__body')!;
    expect(body.classList).not.toContain('side-panel__body--scroll');
    fixture.componentRef.setInput('scroll', true);
    fixture.detectChanges();
    expect(body.classList).toContain('side-panel__body--scroll');
  });
});
