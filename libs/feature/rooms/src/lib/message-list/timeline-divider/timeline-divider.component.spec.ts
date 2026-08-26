import { render } from '@trinity/testing';
import { TimelineDividerComponent } from './timeline-divider.component';

describe('TimelineDividerComponent', () => {
  it('announces a day boundary as a separator carrying its date', async () => {
    const { container } = await render(TimelineDividerComponent, {
      inputs: { kind: 'day', label: 'Yesterday' },
    });

    const day = container.querySelector('[data-testid=day-separator]');
    expect(day).toBeTruthy();
    expect(day?.getAttribute('role')).toBe('separator');
    // The label is the separator's accessible NAME; the visible span repeats it and is
    // hidden, so a screen reader does not read the date twice.
    expect(day?.getAttribute('aria-label')).toBe('Yesterday');
    expect(day?.querySelector('.day-divider__label')?.textContent?.trim()).toBe(
      'Yesterday',
    );
    expect(
      day?.querySelector('.day-divider__label')?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(container.querySelector('[data-testid=new-messages-divider]')).toBe(
      null,
    );
  });

  it('renders the unread mark, which announces itself', async () => {
    const { container } = await render(TimelineDividerComponent, {
      inputs: { kind: 'unread' },
    });

    const unread = container.querySelector(
      '[data-testid=new-messages-divider]',
    );
    expect(unread?.textContent).toContain('New messages');
    expect(container.querySelector('[data-testid=day-separator]')).toBe(null);
  });

  it('ignores a label on the unread mark rather than leaking it into the text', async () => {
    // `label` is only meaningful for `day`. A divider that rendered a stale date next to
    // "New messages" would be a confusing thing to have to debug from a screenshot.
    const { container } = await render(TimelineDividerComponent, {
      inputs: { kind: 'unread', label: 'Yesterday' },
    });

    expect(container.textContent).not.toContain('Yesterday');
  });

  // The testids above are not decoration: `MessageListBase.updateJumpToUnread()` finds the
  // unread mark with `querySelector('[data-testid="new-messages-divider"]')`, and both are
  // queried by the Playwright suite. Renaming one breaks the jump pill silently.
});
