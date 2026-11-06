import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { MockComponent } from 'ng-mocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationRuntime,
  type MessageView,
} from '@trinity/data-access/timeline';
import { MessageComposerComponent } from '../message-composer/message-composer.component';
import { ENTER_CLEAR_MS, MessageListComponent } from './message-list.component';
import {
  ConversationComposeStub,
  ConversationMessagesStub,
} from '../testing/conversation-timeline.stub';
import { setScrollGeometry } from '../testing/scroll-geometry.stub';
import { messageView } from '../testing/message-view.fixture';

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock('@trinity/util/ui', async (importActual) => ({
  ...(await importActual<typeof import('@trinity/util/ui')>()),
  prefersReducedMotion: () => motion.reduced,
}));

const EST = 64;

function msg(id: string, over: Partial<MessageView> = {}): MessageView {
  return messageView({ id, body: `body ${id}`, ...over });
}

function many(n: number): MessageView[] {
  return Array.from({ length: n }, (_, i) => msg(`$${i}`));
}

/** The prefix sums are private; read their total through a narrow view. */
const totalHeight = (cmp: MessageListComponent): number => {
  const prefix = (cmp as unknown as { prefix: () => number[] }).prefix();
  return prefix[prefix.length - 1];
};

interface TestRO {
  observed: Set<Element>;
  emit(entries: ResizeObserverEntry[]): void;
}
function rowObserver(): TestRO {
  const ro = (
    ResizeObserver as unknown as { instances: TestRO[] }
  ).instances.find((o) => [...o.observed].some((el) => el.matches?.('.msg')));
  if (!ro) throw new Error('row ResizeObserver not found');
  return ro;
}
const resizeEntry = (target: Element, height: number): ResizeObserverEntry =>
  ({
    target,
    borderBoxSize: [{ blockSize: height, inlineSize: 0 }],
    contentRect: { height } as DOMRectReadOnly,
  }) as unknown as ResizeObserverEntry;

describe('message list — new messages slide in', () => {
  beforeEach(() => {
    const compose = new ConversationComposeStub();
    TestBed.overrideProvider(ConversationRuntime, {
      useValue: { compose, messages: new ConversationMessagesStub(compose) },
    });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    (ResizeObserver as unknown as { instances: unknown[] }).instances.length =
      0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    motion.reduced = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function setup(
    messages: MessageView[] = many(10),
    inputs: Record<string, unknown> = {},
  ) {
    const rendered = await render(MessageListComponent, {
      inputs: { messages, ...inputs },
      imports: [MockComponent(MessageComposerComponent)],
    });
    const { fixture, container } = rendered;
    let current = messages;
    const show = async (next: MessageView[]) => {
      current = next;
      fixture.componentRef.setInput('messages', next);
      fixture.detectChanges();
      await fixture.whenStable();
    };
    const append = (...rows: MessageView[]) => show([...current, ...rows]);
    const scroll = container.querySelector('.scroll') as HTMLElement;
    const view = { st: 0 };
    setScrollGeometry(scroll, {
      scrollTop: { get: () => view.st, set: (v: number) => (view.st = v) },
      clientHeight: 600,
      scrollHeight: 20_000,
    });
    const scrollUp = () => {
      view.st = 0;
      scroll.dispatchEvent(new Event('scroll'));
    };
    const host = (id: string) =>
      container
        .querySelector(`[data-mid="${id}"]`)
        ?.closest('trn-message-row') as HTMLElement;
    const entering = () => container.querySelectorAll('.msg-enter');
    return {
      ...rendered,
      cmp: fixture.componentInstance,
      show,
      append,
      scroll,
      scrollUp,
      host,
      entering,
      current: () => current,
    };
  }

  it('tracks rows by key', async () => {
    const send = msg('$local', { key: '~txn:1', isOwn: true });
    const { show, host } = await setup([...many(3), send]);
    const before = host('$local');

    await show([...many(3), { ...send, id: '$remote' }]);

    expect(host('$remote')).toBe(before);
  });

  it('keeps the measured height across an echo rename', async () => {
    const send = msg('$local', { key: '~txn:1', isOwn: true });
    const { cmp, show, container } = await setup([...many(199), send]);
    const row = container.querySelector('[data-mid="$local"]') as Element;
    rowObserver().emit([resizeEntry(row, 120)]);
    expect(totalHeight(cmp)).toBe(199 * EST + 120);

    await show([...many(199), { ...send, id: '$remote' }]);
    expect(totalHeight(cmp)).toBe(199 * EST + 120);

    // The same element measures again: the new height lands on the new id.
    rowObserver().emit([resizeEntry(row, 130)]);
    expect(totalHeight(cmp)).toBe(199 * EST + 130);
  });

  it('keeps a run of system lines expanded as it grows', async () => {
    const line = (id: string) => msg(id, { kind: 'event' });
    const { cmp, append } = await setup([...many(3), line('$e1'), line('$e2')]);
    cmp.toggleRun('group:$e2');

    await append(line('$e3'));

    expect([...cmp.expandedRuns()]).toEqual(['group:$e3']);
  });

  it('marks a live receive at the bottom', async () => {
    const { append, host } = await setup();

    await append(msg('$new'));
    expect(host('$new').classList).toContain('msg-enter');

    vi.advanceTimersByTime(ENTER_CLEAR_MS);
    TestBed.tick();
    expect(host('$new').classList).not.toContain('msg-enter');
  });

  it('marks your own send while scrolled up', async () => {
    const { append, scrollUp, host } = await setup();
    scrollUp();

    await append(msg('$mine', { isOwn: true }));

    expect(host('$mine').classList).toContain('msg-enter');
  });

  it('marks every row of a burst', async () => {
    const { append, entering } = await setup();

    await append(msg('$x'), msg('$y'), msg('$z'));

    expect(
      [...entering()].map((el) =>
        el.querySelector('[data-mid]')?.getAttribute('data-mid'),
      ),
    ).toEqual(['$x', '$y', '$z']);
  });

  it('keeps a later mark after an earlier timer', async () => {
    const { append, host } = await setup();

    await append(msg('$a'));
    vi.advanceTimersByTime(150);
    await append(msg('$b'));
    vi.advanceTimersByTime(120);
    TestBed.tick();

    expect(host('$a').classList).not.toContain('msg-enter');
    expect(host('$b').classList).toContain('msg-enter');
  });

  describe('does not mark', () => {
    it('the first batch', async () => {
      const { entering } = await setup();
      expect(entering()).toHaveLength(0);
    });

    it('prepended history', async () => {
      const { fixture, show, scroll, entering, current } = await setup(
        many(10),
        { canLoadOlder: true },
      );
      // Near the top with more history: the scroll asks for older rows.
      scroll.dispatchEvent(new Event('scroll'));
      fixture.componentRef.setInput('loadingOlder', true);
      fixture.detectChanges();
      fixture.componentRef.setInput('loadingOlder', false);

      await show([msg('$old1'), msg('$old2'), ...current()]);

      expect(entering()).toHaveLength(0);
    });

    it('a receive while scrolled up', async () => {
      const { append, scrollUp, entering } = await setup();
      scrollUp();

      await append(msg('$new'));

      expect(entering()).toHaveLength(0);
    });

    it('a re-projection of the same rows', async () => {
      const { show, current, entering } = await setup();

      await show(current().map((m) => ({ ...m })));

      expect(entering()).toHaveLength(0);
    });

    it('a replaced window', async () => {
      const { show, entering } = await setup();

      await show([msg('$p'), msg('$q')]);

      expect(entering()).toHaveLength(0);
    });

    it('a row remounted after windowing away and back', async () => {
      const { fixture, scroll, entering } = await setup(many(200));
      const scrollTo = (top: number) => {
        (scroll as unknown as { scrollTop: number }).scrollTop = top;
        scroll.dispatchEvent(new Event('scroll'));
        fixture.detectChanges();
      };

      scrollTo(0);
      scrollTo(200 * EST);

      expect(entering()).toHaveLength(0);
    });

    it('a receive after a jump', async () => {
      const { cmp, append, entering } = await setup();
      Element.prototype.scrollIntoView = vi.fn();

      cmp.jumpTo('$2');
      await append(msg('$new'));

      expect(entering()).toHaveLength(0);
    });

    it('anything when the reader prefers reduced motion', async () => {
      motion.reduced = true;
      const { append, entering } = await setup();

      await append(msg('$new'), msg('$mine', { isOwn: true }));

      expect(entering()).toHaveLength(0);
    });
  });

  it('clears marks on room switch', async () => {
    const { fixture, append, entering } = await setup();
    await append(msg('$new'));
    expect(entering()).toHaveLength(1);

    fixture.componentRef.setInput('roomId', '!other:hs');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(entering()).toHaveLength(0);
  });
});
