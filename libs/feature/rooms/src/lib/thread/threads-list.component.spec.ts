import { signal } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { render } from '@trinity/testing';
import {
  ThreadsService,
  type ThreadSummary,
} from '@trinity/data-access/timeline';
import { AvatarComponent } from '@trinity/ui';
import { MockComponent, MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
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
  const dismiss = vi.fn().mockResolvedValue(true);
  const { fixture, container } = await render(ThreadsListComponent, {
    inputs: { roomId: '!r:hs' },
    imports: [MockComponent(AvatarComponent)],
    providers: [
      MockProvider(ThreadsService, { threadList }),
      MockProvider(DialogRef, { close: dismiss }),
    ],
  });
  return { fixture, container, dismiss };
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

  it('closes with the chosen thread-root id when a row is tapped', async () => {
    const { container, dismiss } = await build([
      summary({ rootEventId: '$pick' }),
    ]);

    container.querySelector<HTMLElement>('.thread-item')!.click();

    expect(dismiss).toHaveBeenCalledWith('$pick');
  });

  it('closes with no payload when closed', async () => {
    const { fixture, dismiss } = await build([summary()]);

    fixture.componentInstance.close();

    expect(dismiss).toHaveBeenCalledWith();
  });

  it('shows an empty state when there are no threads', async () => {
    const { container } = await build([]);

    expect(container.querySelector('.threads__empty')).toBeTruthy();
  });
});
