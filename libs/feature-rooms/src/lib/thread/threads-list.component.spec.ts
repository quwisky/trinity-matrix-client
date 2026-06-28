import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ModalController } from '@ionic/angular/standalone';
import { ThreadsService, type ThreadSummary } from '@trinity/core';
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

function build(threads: ThreadSummary[] = []) {
  const threadList = signal<ThreadSummary[]>(threads);
  const dismiss = vi.fn().mockResolvedValue(true);
  TestBed.configureTestingModule({
    imports: [ThreadsListComponent],
    providers: [
      { provide: ThreadsService, useValue: { threadList } },
      { provide: ModalController, useValue: { dismiss } },
    ],
  });
  const fixture = TestBed.createComponent(ThreadsListComponent);
  fixture.componentRef.setInput('roomId', '!r:hs');
  return { fixture, dismiss };
}

describe('ThreadsListComponent', () => {
  it('renders a row per thread with root preview, reply count, and last reply', () => {
    const { fixture } = build([
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
    fixture.detectChanges();

    const items = fixture.nativeElement.querySelectorAll('.thread-item');
    expect(items.length).toBe(2);
    expect(fixture.nativeElement.textContent).toContain('first thread');
    expect(fixture.nativeElement.textContent).toContain('2 replies');
    expect(fixture.nativeElement.textContent).toContain('1 reply');
    expect(fixture.nativeElement.textContent).toContain('Bob:');
    expect(fixture.nativeElement.textContent).toContain('a reply');
  });

  it('renders threads in the order the service provides (already sorted)', () => {
    const { fixture } = build([
      summary({ rootEventId: '$new', rootPreview: 'newer' }),
      summary({ rootEventId: '$old', rootPreview: 'older' }),
    ]);
    fixture.detectChanges();

    const roots = [
      ...fixture.nativeElement.querySelectorAll('.thread-item__root'),
    ].map((el: HTMLElement) => el.textContent?.trim());
    expect(roots).toEqual(['newer', 'older']);
  });

  it('shows an unread badge (highlight variant) when the thread is unread', () => {
    const { fixture } = build([summary({ unreadCount: 4, highlight: true })]);
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector('.thread-item__badge');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain('4');
    expect(badge.classList.contains('thread-item__badge--highlight')).toBe(
      true,
    );
  });

  it('omits the unread badge for a read thread', () => {
    const { fixture } = build([summary({ unreadCount: 0 })]);
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('.thread-item__badge'),
    ).toBeNull();
  });

  it('dismisses with the chosen thread-root id when a row is tapped', () => {
    const { fixture, dismiss } = build([summary({ rootEventId: '$pick' })]);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('.thread-item').click();

    expect(dismiss).toHaveBeenCalledWith('$pick');
  });

  it('dismisses with no payload when closed', () => {
    const { fixture, dismiss } = build([summary()]);
    fixture.detectChanges();

    fixture.componentInstance.close();

    expect(dismiss).toHaveBeenCalledWith();
  });

  it('shows an empty state when there are no threads', () => {
    const { fixture } = build([]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.threads__empty')).toBeTruthy();
  });
});
