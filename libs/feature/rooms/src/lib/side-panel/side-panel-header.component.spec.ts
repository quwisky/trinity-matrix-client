import { render, screen } from '@trinity/testing';
import { provideTrnIcons } from '@trinity/components/foundations';
import { signal } from '@angular/core';
import {
  RIGHT_PANEL_PAGE,
  SidePanelHeaderComponent,
} from './side-panel-header.component';

describe('SidePanelHeaderComponent', () => {
  it('titles the panel and closes it', async () => {
    const closed = vi.fn();
    await render(SidePanelHeaderComponent, {
      inputs: { title: 'Members', closeTestId: 'close-members' },
      on: { closed },
      providers: [provideTrnIcons()],
    });
    expect(
      screen.getByRole('heading', { level: 2, name: 'Members' }),
    ).toBeTruthy();
    screen.getByTestId('close-members').click();
    expect(closed).toHaveBeenCalledOnce();
  });

  it('renders no subtitle or icon by default', async () => {
    const { container } = await render(SidePanelHeaderComponent, {
      inputs: { title: 'Members' },
      providers: [provideTrnIcons()],
    });
    expect(container.querySelector('.side-panel-header__subtitle')).toBeNull();
    expect(container.querySelector('.side-panel-header__icon')).toBeNull();
  });

  it('shows the subtitle inline after the title, inside the heading', async () => {
    await render(SidePanelHeaderComponent, {
      inputs: { title: 'Thread', subtitle: 'General' },
      providers: [provideTrnIcons()],
    });
    expect(
      screen.getByRole('heading', { level: 2, name: 'Thread General' }),
    ).toBeTruthy();
  });

  it('names a long heading by its first 80 characters, and still shows all of it', async () => {
    const long = 'word '.repeat(40).trim();
    await render(SidePanelHeaderComponent, {
      inputs: { title: long, subtitle: 'general' },
      providers: [provideTrnIcons()],
    });
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.getAttribute('aria-label')).toBe(
      `${long.slice(0, 80).trimEnd()}… general`,
    );
    expect(heading.textContent).toContain(long);
  });

  it('leaves a short heading to its own text', async () => {
    await render(SidePanelHeaderComponent, {
      inputs: { title: 'Threads' },
      providers: [provideTrnIcons()],
    });
    expect(
      screen.getByRole('heading', { level: 2 }).getAttribute('aria-label'),
    ).toBeNull();
  });

  it('leads the title with the panel icon', async () => {
    const { container } = await render(SidePanelHeaderComponent, {
      inputs: { title: 'Members', icon: 'users' },
      providers: [provideTrnIcons()],
    });
    const icon = container.querySelector('.side-panel-header__icon')!;
    const heading = screen.getByRole('heading', { name: 'Members' });
    expect(
      icon.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('names its close button after the panel beside the room, after the title', async () => {
    await render(SidePanelHeaderComponent, {
      inputs: { title: 'Threads', closeLabel: 'Close threads' },
      providers: [provideTrnIcons()],
    });
    const button = screen.getByRole('button', { name: 'Close threads' });
    const heading = screen.getByRole('heading', { name: 'Threads' });
    expect(
      heading.compareDocumentPosition(button) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('leads a page with a Back button, first in reading and focus order', async () => {
    const closed = vi.fn();
    await render(SidePanelHeaderComponent, {
      inputs: { title: 'Threads', closeLabel: 'Close threads' },
      on: { closed },
      providers: [
        provideTrnIcons(),
        { provide: RIGHT_PANEL_PAGE, useValue: signal(true) },
      ],
    });
    expect(screen.queryByRole('button', { name: 'Close threads' })).toBeNull();
    const button = screen.getByRole('button', { name: 'Back' });
    const heading = screen.getByRole('heading', { name: 'Threads' });
    expect(
      button.compareDocumentPosition(heading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    button.click();
    expect(closed).toHaveBeenCalledOnce();
  });
});
