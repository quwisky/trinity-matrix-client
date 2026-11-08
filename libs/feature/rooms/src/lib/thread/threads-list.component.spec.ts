import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { lastInputTarget } from '@trinity/components/overlay';
import { render } from '@trinity/testing';
import {
  ConversationRuntime,
  type ThreadSummary,
} from '@trinity/data-access/timeline';
import { AvatarComponent } from '@trinity/components/generic-content';
import { MockComponent } from 'ng-mocks';
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
    rootShield: null,
    latestReplyShield: null,
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
    providers: [
      {
        provide: ConversationRuntime,
        useValue: { threads: { list: threadList.asReadonly() } },
      },
    ],
  });
  /** Everything this panel announces, in order, so a test can pin both channels. */
  const picked: string[] = [];
  let dismissals = 0;
  fixture.componentInstance.selected.subscribe((id) => picked.push(id));
  fixture.componentInstance.dismissed.subscribe(() => (dismissals += 1));
  return { fixture, container, picked, dismissals: () => dismissals };
}

describe('ThreadsListComponent', () => {
  // Picking a thread replaces this list with the thread view; the CDK's input-modality
  // detector kept the pressed row, and through it the whole detached list (#1361).
  it('lets go of the last pressed element inside it when it goes', async () => {
    const { fixture, container } = await build([summary()]);
    const row = container.querySelector('.thread-item') as HTMLElement;
    const last = () => TestBed.runInInjectionContext(lastInputTarget);
    row.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, buttons: 1, detail: 1 }),
    );
    expect(last()).toBe(row);

    fixture.destroy();

    expect(last()).toBeNull();
  });

  it('marks a root that arrived unencrypted', async () => {
    const shield = {
      level: 'unencrypted' as const,
      reason: 'Not encrypted',
      explanation: 'This message was sent without end-to-end encryption.',
    };
    const { container } = await build([summary({ rootShield: shield })]);

    const marks = container.querySelectorAll(
      '[data-testid="unencrypted-mark-unencrypted"]',
    );
    expect(marks).toHaveLength(1);
    expect(marks[0].getAttribute('aria-label')).toBe('Not encrypted');
  });

  it('renders a row per thread with its text and "Author · N replies · when"', async () => {
    const now = Date.now();
    const { container } = await build([
      summary({
        rootEventId: '$a',
        rootPreview: 'first thread',
        replyCount: 2,
        latestActivityTs: now - 2 * 60_000,
      }),
      summary({
        rootEventId: '$b',
        rootPreview: 'second thread',
        replyCount: 1,
        latestActivityTs: now,
      }),
    ]);

    const items = container.querySelectorAll('.thread-item');
    expect(items.length).toBe(2);
    const meta = [
      ...container.querySelectorAll<HTMLElement>('.thread-item__meta'),
    ].map((el) => el.textContent?.trim());
    expect(meta).toEqual([
      'Alice · 2 replies · 2 min. ago',
      'Alice · 1 reply · now',
    ]);
  });

  it('lists unread threads first under "Unread", then the rest under "Other threads"', async () => {
    const { container } = await build([
      summary({ rootEventId: '$read', rootPreview: 'read one' }),
      summary({ rootEventId: '$new', rootPreview: 'new one', unreadCount: 3 }),
    ]);

    const labels = [
      ...container.querySelectorAll<HTMLElement>(
        '[data-testid="threads-section"]',
      ),
    ].map((el) => el.textContent?.trim());
    expect(labels).toEqual(['Unread', 'Other threads']);
    const roots = [
      ...container.querySelectorAll<HTMLElement>('.thread-item__root'),
    ].map((el) => el.textContent?.trim());
    expect(roots).toEqual(['new one', 'read one']);
  });

  it('leaves out a group with no threads', async () => {
    const { container } = await build([summary()]);

    const labels = [
      ...container.querySelectorAll<HTMLElement>(
        '[data-testid="threads-section"]',
      ),
    ].map((el) => el.textContent?.trim());
    expect(labels).toEqual(['All threads']);
  });

  it("leads with the root's author and stacks up to three others", async () => {
    const person = (id: string) => ({
      id,
      name: id,
      initial: id[1].toUpperCase(),
      avatarMxc: null,
    });
    const { container } = await build([
      summary({
        participants: ['@alice', '@bo', '@cy', '@di', '@ed'].map(person),
      }),
    ]);

    const row = container.querySelector('.thread-item')!;
    expect(row.children[0].tagName).toBe('TRN-AVATAR');
    expect(row.querySelectorAll('.thread-item__stack trn-avatar')).toHaveLength(
      3,
    );
    expect(
      row.querySelector('.thread-item__stack')?.getAttribute('aria-hidden'),
    ).toBe('true');
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

  it('shows an unread badge when the thread is unread', async () => {
    const { container } = await build([
      summary({ unreadCount: 4, highlight: true }),
    ]);

    const badge = container.querySelector('[trnBadge]');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toContain('4');
    expect(badge).toHaveAttribute('data-variant', 'danger');
    expect(badge?.getAttribute('aria-label')).toBe('4 unread mentions');
  });

  it('names a single unread mention in the singular', async () => {
    const { container } = await build([
      summary({ unreadCount: 1, highlight: true }),
    ]);

    expect(
      container.querySelector('[trnBadge]')?.getAttribute('aria-label'),
    ).toBe('1 unread mention');
  });

  it('reads old activity in weeks, months and years, not hundreds of days', async () => {
    const day = 86_400_000;
    const { container } = await build([
      summary({ rootEventId: '$w', latestActivityTs: Date.now() - 14 * day }),
      summary({ rootEventId: '$y', latestActivityTs: Date.now() - 800 * day }),
    ]);

    const meta = [
      ...container.querySelectorAll<HTMLElement>('.thread-item__meta'),
    ].map((el) => el.textContent?.trim());
    expect(meta).toEqual([
      'Alice · 2 replies · 2 wk. ago',
      'Alice · 2 replies · 2 yr. ago',
    ]);
  });

  it('uses the same badge for an unread thread without a mention, named apart', async () => {
    const { container } = await build([
      summary({ unreadCount: 2, highlight: false }),
    ]);

    const badge = container.querySelector('[trnBadge]');
    expect(badge).toHaveAttribute('data-variant', 'danger');
    expect(badge?.getAttribute('aria-label')).toBe('2 unread');
  });

  it('omits the unread badge for a read thread', async () => {
    const { container } = await build([summary({ unreadCount: 0 })]);

    expect(container.querySelector('[trnBadge]')).toBeNull();
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

    // The text, not the class: what this test has always been about is that the reader is
    // told there is nothing here, and how to change that.
    const empty = container.querySelector('trn-side-panel-empty')!;
    expect(empty.getAttribute('role')).toBe('status');
    expect(empty.querySelector('h3')?.textContent).toBe('No threads yet');
    expect(empty.textContent).toContain('Reply to a message in a thread');
  });
});
