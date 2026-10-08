import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { render } from '@trinity/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageListComponent } from './message-list.component';
import type {
  MessageView,
  TimelineLoadState,
} from '@trinity/data-access/timeline';
import { MessageComposerComponent } from '../message-composer/message-composer.component';

/**
 * The "Loading older messages…" strip, and when it is allowed to appear.
 *
 * A new file rather than more tests in `message-list.component.unwindowed.spec.ts`: that one is
 * already at 48 TestBed tests, and a TestBed test retains enough that a single file has
 * previously died part-way through and reported the rest as never run.
 *
 * Backfilling a page of history is usually faster than a person can register, so binding
 * `loadingOlder` straight to the template flashed this strip on most scrolls back — motion
 * at the top of the timeline, in exactly the spot being read. It goes through `delayedBusy`
 * now, and these pin the two ends of that: nothing for a quick load, and once shown it stays
 * long enough to be read.
 */
describe('message list — loading older', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const advance = (ms: number) => {
    vi.advanceTimersByTime(ms);
    TestBed.tick();
  };

  const strip = (container: HTMLElement) =>
    container.querySelector('.load-older');

  async function create() {
    const result = await render(MessageListComponent, {
      inputs: { messages: [], loadingOlder: false },
    });
    TestBed.tick();
    return result;
  }

  it('shows nothing for a backfill that returns quickly', async () => {
    const { container, fixture } = await create();

    fixture.componentRef.setInput('loadingOlder', true);
    TestBed.tick();
    advance(100);
    expect(strip(container)).toBeNull();

    fixture.componentRef.setInput('loadingOlder', false);
    TestBed.tick();
    advance(2000);

    expect(strip(container)).toBeNull();
  });

  it('shows the strip once the backfill is slow enough to be worth mentioning', async () => {
    const { container, fixture } = await create();

    fixture.componentRef.setInput('loadingOlder', true);
    TestBed.tick();
    advance(200);

    expect(strip(container)).not.toBeNull();
    expect(container.textContent).toContain('Loading older messages…');
  });

  it('disappears in the same pass the backfill finishes, not later', async () => {
    // THE property, and it is about layout rather than about looks. The strip is in flow
    // above the rows, and the windowed list's scroll restore folds its height into the
    // calculation that keeps the reader's place across a prepend. `TimelineService` prepends
    // the rows and clears `loadingOlder` together, so the strip has to go with them — held
    // even a moment longer, the restore measures 36px that is about to vanish and the
    // content jumps up by that much once it does.
    //
    // Asserted with no timer advance at all after the flag clears: anything that needs one
    // is, by definition, still on screen when the prepend lands.
    const { container, fixture } = await create();

    fixture.componentRef.setInput('loadingOlder', true);
    TestBed.tick();
    advance(200);
    expect(strip(container)).not.toBeNull();

    fixture.componentRef.setInput('loadingOlder', false);
    TestBed.tick();

    expect(strip(container)).toBeNull();
  });

  it('judges the next backfill on its own duration, rather than flashing the strip at it', async () => {
    // What `minimumMs: 0` buys, and the ONLY thing about it that is observable. The AND in
    // `showLoadingOlder` already removes the strip with the prepend whatever the minimum is,
    // so a hold could never be seen on the way out — it would be seen on the way back in.
    // Scrolling back is repetitive: one slow page is routinely followed by several fast
    // ones, and a `delayedBusy` still serving out a hold is still "visible", so the next
    // backfill would skip the delay entirely and flash the strip for a page nobody noticed
    // was fetched. Set the minimum to anything above zero and this goes red.
    const { container, fixture } = await create();

    // A slow page: long enough to earn the strip.
    fixture.componentRef.setInput('loadingOlder', true);
    TestBed.tick();
    advance(200);
    expect(strip(container)).not.toBeNull();

    fixture.componentRef.setInput('loadingOlder', false);
    TestBed.tick();
    advance(50);

    // A second page, requested well inside any minimum hold and answered faster than the
    // delay. It has earned nothing, so it shows nothing.
    fixture.componentRef.setInput('loadingOlder', true);
    TestBed.tick();
    advance(100);

    expect(strip(container)).toBeNull();
  });
});

function fakeMessage(id: string, body: string): MessageView {
  return {
    id,
    senderId: '@a:hs',
    senderName: 'Alice',
    senderInitial: 'A',
    senderAvatarMxc: null,
    body,
    html: null,
    timestamp: 1000,
    isOwn: false,
    decryptionFailed: false,
    edited: false,
    reactions: [],
    replyTo: null,
    status: null,
    kind: 'text',
    media: null,
    caption: null,
    captionHtml: null,
    readReceipts: [],
    poll: null,
  };
}

describe('message list — conversation load state', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const advance = (ms: number) => {
    vi.advanceTimersByTime(ms);
    TestBed.tick();
  };
  const loading = (partial = false): TimelineLoadState => ({
    kind: 'loading',
    reason: 'backfill',
    partial,
  });
  const skeleton = (c: HTMLElement) =>
    c.querySelector('[data-testid="timeline-skeleton"]');
  const emptyState = (c: HTMLElement) => c.querySelector('trn-empty-state');

  async function create(
    loadState: TimelineLoadState,
    messages: MessageView[] = [],
  ) {
    const result = await render(MessageListComponent, {
      inputs: { messages, loadState },
    });
    TestBed.tick();
    return result;
  }

  it('shows the skeleton only after 150 ms of loading and never the empty state meanwhile', async () => {
    const { container } = await create(loading());
    expect(skeleton(container)).toBeNull();
    expect(emptyState(container)).toBeNull();
    advance(200);
    expect(skeleton(container)).not.toBeNull();
    expect(emptyState(container)).toBeNull();
  });

  it('removes the skeleton the instant loading ends', async () => {
    const { container, fixture } = await create(loading());
    advance(200);
    fixture.componentRef.setInput('loadState', { kind: 'empty' });
    TestBed.tick();
    expect(skeleton(container)).toBeNull();
    expect(emptyState(container)).not.toBeNull();
  });

  it('never shows a skeleton for a ready empty Room', async () => {
    const { container } = await create({ kind: 'empty' });
    advance(1000);
    expect(skeleton(container)).toBeNull();
    expect(emptyState(container)).not.toBeNull();
  });

  it('renders the skeleton above messages when partial', async () => {
    const { container } = await create(loading(true), [
      fakeMessage('$1', 'hello'),
    ]);
    advance(200);
    const sk = skeleton(container)!;
    const firstRow = container.querySelector('trn-message-row')!;
    expect(
      sk.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows the reason copy with Retry on error and emits retryLoad', async () => {
    const { container, fixture } = await create({
      kind: 'error',
      reason: 'backfill-failed',
    });
    const retry = vi.fn();
    fixture.componentInstance.retryLoad.subscribe(retry);
    expect(
      container.querySelector('[data-testid="timeline-load-error"]')
        ?.textContent,
    ).toContain("Couldn't load messages.");
    const panel = emptyState(container);
    expect(panel?.getAttribute('data-testid')).toBe('timeline-load-error');
    expect(panel?.getAttribute('role')).toBe('alert');
    expect(container.querySelectorAll('trn-empty-state')).toHaveLength(1);
    expect(container.textContent).not.toContain('No messages yet');
    (
      container.querySelector(
        '[data-testid="timeline-load-retry"]',
      ) as HTMLButtonElement
    ).click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('blocks sending while loading or failed, not when settled', async () => {
    const { fixture } = await create(loading());
    const composer = () =>
      fixture.debugElement.query(By.directive(MessageComposerComponent))
        .componentInstance as MessageComposerComponent;
    expect(composer().sendBlocked()).toBe(true);
    fixture.componentRef.setInput('loadState', { kind: 'ready' });
    TestBed.tick();
    expect(composer().sendBlocked()).toBe(false);
    fixture.componentRef.setInput('loadState', {
      kind: 'error',
      reason: 'sync-stopped',
    });
    TestBed.tick();
    expect(composer().sendBlocked()).toBe(true);
  });

  it('retries the viewport fill once when loading ends with the same messages', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return 0;
    });
    const flush = () => frames.splice(0).forEach((cb) => cb(0));
    const { fixture } = await create(loading(), [fakeMessage('$1', 'hi')]);
    const loadOlder = vi.fn();
    fixture.componentInstance.loadOlder.subscribe(loadOlder);
    fixture.componentRef.setInput('canLoadOlder', true);
    fixture.componentRef.setInput('oldestEventId', '$1');
    TestBed.tick();
    flush();
    expect(loadOlder).not.toHaveBeenCalled();
    fixture.componentRef.setInput('loadState', { kind: 'ready' });
    TestBed.tick();
    flush();
    expect(loadOlder).toHaveBeenCalledOnce();
  });

  it('does not auto-load older while loading', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return 0;
    });
    const { fixture } = await create(loading());
    const loadOlder = vi.fn();
    fixture.componentInstance.loadOlder.subscribe(loadOlder);
    fixture.componentRef.setInput('canLoadOlder', true);
    fixture.componentRef.setInput('oldestEventId', '$1');
    TestBed.tick();
    frames.splice(0).forEach((cb) => cb(0));
    advance(500);
    expect(loadOlder).not.toHaveBeenCalled();
  });
});
