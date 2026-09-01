import { render } from '@trinity/testing';
import { MessageThreadSummaryComponent } from './message-thread-summary.component';

describe('MessageThreadSummaryComponent', () => {
  const summary = {
    rootEventId: '$root',
    rootPreview: 'root message',
    rootSenderName: 'Alice',
    replyCount: 3,
    latestReplyTs: 1,
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
    expect(container.textContent).toContain('last reply 12:30');
    expect(container.querySelector('.msg__thread-badge')).toHaveClass(
      'msg__thread-badge--highlight',
    );
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'View thread, 3 replies, 2 unread',
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
});
