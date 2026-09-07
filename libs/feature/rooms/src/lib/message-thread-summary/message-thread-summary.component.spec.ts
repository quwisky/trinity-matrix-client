import { render } from '@trinity/testing';
import { MessageThreadSummaryComponent } from './message-thread-summary.component';

describe('MessageThreadSummaryComponent', () => {
  const now = new Date('2026-09-07T12:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(now);
  });

  afterEach(() => vi.useRealTimers());
  const summary = {
    rootEventId: '$root',
    rootPreview: 'root message',
    rootSenderName: 'Alice',
    replyCount: 3,
    latestReplyTs: now - 120_000,
    latestActivityTs: 1,
    latestReplyPreview: 'latest reply',
    latestReplySenderName: 'Bob',
    participants: [],
    unreadCount: 2,
    highlight: true,
  };

  it('renders reply, time, and highlighted unread evidence', async () => {
    const { container } = await render(MessageThreadSummaryComponent, {
      inputs: { summary, latestReplyLabel: '12:30' },
    });

    expect(container.textContent).toContain('3 replies');
    expect(
      container.querySelector('.msg__thread-preview')?.textContent,
    ).toContain('Bob');
    expect(
      container.querySelector('.msg__thread-preview')?.textContent,
    ).toContain('latest reply');
    expect(container.querySelector('.msg__thread-time')).toHaveAttribute(
      'title',
      '12:30',
    );
    expect(container.textContent).toContain('2 min. ago');
    expect(container.querySelector('.msg__thread-badge')).toHaveClass(
      'msg__thread-badge--highlight',
    );
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'View thread, 3 replies, 2 unread, including mentions, Bob: latest reply, 2 min. ago',
    );
  });

  it('uses singular copy and emits open', async () => {
    const { container, fixture } = await render(MessageThreadSummaryComponent, {
      inputs: {
        summary: { ...summary, replyCount: 1, unreadCount: 0 },
      },
    });
    const opened = vi.fn();
    fixture.componentInstance.open.subscribe(opened);

    container.querySelector('button')?.click();

    expect(container.textContent).toContain('1 reply');
    expect(container.querySelector('.msg__thread-badge')).toBeNull();
    expect(opened).toHaveBeenCalledOnce();
  });

  it('keeps a thread openable when its latest reply is unavailable', async () => {
    const { container } = await render(MessageThreadSummaryComponent, {
      inputs: {
        summary: {
          ...summary,
          latestReplyTs: null,
          latestReplyPreview: '',
          latestReplySenderName: '',
          unreadCount: 0,
        },
      },
    });

    expect(container.querySelector('button')).toHaveAccessibleName(
      'View thread, 3 replies',
    );
    expect(container.querySelector('.msg__thread-preview')).toBeNull();
    expect(container.querySelector('.msg__thread-time')).toBeNull();
  });

  it('updates relative time while mounted and releases its timer on destruction', async () => {
    const { container, fixture } = await render(MessageThreadSummaryComponent, {
      inputs: { summary: { ...summary, latestReplyTs: now } },
    });
    expect(container.querySelector('.msg__thread-time')).toHaveTextContent(
      'just now',
    );

    await vi.advanceTimersByTimeAsync(60_000);
    fixture.detectChanges();
    expect(container.querySelector('.msg__thread-time')).toHaveTextContent(
      '1 min. ago',
    );

    fixture.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [65 * 60_000, '1 hr. ago'],
    [25 * 60 * 60_000, '1 day ago'],
    [-60_000, 'just now'],
  ])('formats reply age %i ms as %s', async (age, expected) => {
    const { container } = await render(MessageThreadSummaryComponent, {
      inputs: { summary: { ...summary, latestReplyTs: now - age } },
    });
    expect(container.querySelector('.msg__thread-time')).toHaveTextContent(
      expected,
    );
  });
});
