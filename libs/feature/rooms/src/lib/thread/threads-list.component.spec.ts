import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import {
  ThreadsService,
  type ThreadSummary,
} from '@trinity/data-access/timeline';
import { AvatarComponent } from '@trinity/components/avatar';
import { MockComponent, MockProvider } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import { ThreadsListComponent } from './threads-list.component';

function summary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    rootEventId: '$root',
    rootPreview: 'a root message',
    rootSenderName: 'Alice',
    replyCount: 2,
    latestReplyTs: 2000,
    latestActivityTs: 2000,
    latestReplyPreview: 'a reply',
    latestReplySenderName: 'Bob',
    participants: [],
    unreadCount: 0,
    highlight: false,
    ...overrides,
  };
}

async function build(threads: ThreadSummary[] = []) {
  const threadList = signal<ThreadSummary[]>(threads);
  const { fixture, container } = await render(ThreadsListComponent, {
    inputs: { roomId: '!r:hs' },
    imports: [MockComponent(AvatarComponent)],
    providers: [MockProvider(ThreadsService, { threadList })],
  });
  /** Everything this panel announces, in order, so a test can pin both channels. */
  const picked: string[] = [];
  let dismissals = 0;
  fixture.componentInstance.selected.subscribe((id) => picked.push(id));
  fixture.componentInstance.dismissed.subscribe(() => (dismissals += 1));
  return { fixture, container, picked, dismissals: () => dismissals };
}

describe('ThreadsListComponent', () => {
  it('renders a row per thread with root preview, reply count, and last reply', async () => {
    const { container } = await build([
      summary({
        rootEventId: '$a',
        rootPreview: 'first thread',
        replyCount: 2,
      }),
      summary({
        rootEventId: '$b',
        rootPreview: 'second thread',
        replyCount: 1,
      }),
    ]);

    const items = container.querySelectorAll('.thread-item');
    expect(items.length).toBe(2);
    expect(container.textContent).toContain('first thread');
    expect(container.textContent).toContain('2 replies');
    expect(container.textContent).toContain('1 reply');
    expect(container.textContent).toContain('Bob:');
    expect(container.textContent).toContain('a reply');
  });

  it('renders threads in the order the service provides (already sorted)', async () => {
    const { container } = await build([
      summary({ rootEventId: '$new', rootPreview: 'newer' }),
      summary({ rootEventId: '$old', rootPreview: 'older' }),
    ]);

    const roots = [
      ...container.querySelectorAll<HTMLElement>('.thread-item__root'),
    ].map((el) => el.textContent?.trim());
    expect(roots).toEqual(['newer', 'older']);
  });

  it('shows an unread badge (highlight variant) when the thread is unread', async () => {
    const { container } = await build([
      summary({ unreadCount: 4, highlight: true }),
    ]);

    const badge = container.querySelector('.thread-item__badge');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toContain('4');
    expect(badge?.classList.contains('thread-item__badge--highlight')).toBe(
      true,
    );
  });

  it('omits the unread badge for a read thread', async () => {
    const { container } = await build([summary({ unreadCount: 0 })]);

    expect(container.querySelector('.thread-item__badge')).toBeNull();
  });

  it('announces the chosen thread-root id when a row is tapped', async () => {
    const { container, picked, dismissals } = await build([
      summary({ rootEventId: '$pick' }),
    ]);

    container.querySelector<HTMLElement>('.thread-item')!.click();

    expect(picked).toEqual(['$pick']);
    // Picking is not a dismissal: the page keeps the slot, it just swaps what is in it.
    expect(dismissals()).toBe(0);
  });

  it('announces a dismissal, with nothing picked, when closed', async () => {
    const { fixture, picked, dismissals } = await build([summary()]);

    fixture.componentInstance.close();

    expect(dismissals()).toBe(1);
    expect(picked).toEqual([]);
  });

  it('shows an empty state when there are no threads', async () => {
    const { container } = await build([]);

    // The text, not the class: the panel is a `trn-empty-state` now, and what this test
    // has always been about is that the reader is told there is nothing here.
    expect(container.textContent).toContain('No threads in this channel yet.');
  });
});
