import { TestBed } from '@angular/core/testing';
import { TrnToastService } from '@trinity/components/overlay';
import {
  MediaPipeline,
  type PresentedMediaReference,
} from '@trinity/data-access/media';
import {
  ConversationRuntime,
  type MessageView,
} from '@trinity/data-access/timeline';
import { HostFileExportService } from '@trinity/runtime/host';
import { render } from '@trinity/testing';
import { MockComponent, MockProvider } from 'ng-mocks';
import { of, type Observable } from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { MessageComposerComponent } from '../message-composer/message-composer.component';
import { TimelineMediaGate } from '../shared/timeline-media-gate';
import { TimelineScrollActivity } from '../shared/timeline-scroll-activity';
import {
  ConversationComposeStub,
  ConversationMessagesStub,
} from '../testing/conversation-timeline.stub';
import {
  TestIntersectionObserver,
  stubIntersectionObserver,
} from '../testing/intersection-observer.stub';
import { MessageListComponent } from './message-list.component';
import { setScrollGeometry } from '../testing/scroll-geometry.stub';

function message(id: string, media: PresentedMediaReference | null = null) {
  return {
    id,
    senderId: '@a:hs',
    senderName: 'A',
    senderInitial: 'A',
    senderAvatarMxc: null,
    body: media ? 'pic.png' : `body ${id}`,
    html: null,
    timestamp: 1_000,
    isOwn: false,
    decryptionFailed: false,
    edited: false,
    reactions: [],
    replyTo: null,
    status: null,
    kind: media ? 'image' : 'text',
    media,
    caption: null,
    captionHtml: null,
    readReceipts: [],
    poll: null,
  } as MessageView;
}

const PICTURE = {
  id: 'presented-media-pic',
  kind: 'image',
  filename: 'pic.png',
  mimeType: 'image/png',
} as PresentedMediaReference;

describe('MessageListComponent and the images of its rows', () => {
  let resolveMedia: Mock<
    (media: PresentedMediaReference, variant: string) => Observable<string>
  >;
  let clock: number;

  beforeEach(() => {
    stubIntersectionObserver();
    // Anchoring's frame callbacks would fight the scroll positions these tests set.
    vi.stubGlobal('requestAnimationFrame', () => 0);
    clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    resolveMedia = vi.fn(() => of('blob:pic'));
    const compose = new ConversationComposeStub();
    TestBed.overrideProvider(ConversationRuntime, {
      useValue: { compose, messages: new ConversationMessagesStub(compose) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderList(
    inputs: Partial<{
      messages: MessageView[];
      deferMediaWhileScrolling: boolean;
    }>,
  ) {
    return render(MessageListComponent, {
      inputs,
      imports: [MockComponent(MessageComposerComponent)],
      providers: [
        MockProvider(MediaPipeline, {
          resolveMedia,
          pin: vi.fn(),
          unpin: vi.fn(),
          drop: vi.fn(),
          uploadLimit: () => of(null),
        }),
        MockProvider(HostFileExportService),
        MockProvider(TrnToastService),
      ],
    });
  }

  function scroller(container: Element): HTMLElement {
    const scroll = container.querySelector('.scroll') as HTMLElement;
    let top = 0;
    setScrollGeometry(scroll, {
      scrollTop: {
        get: () => top,
        set: (value: number) => (top = value),
      },
    });
    return scroll;
  }

  /** The reader moves the list to `top` at `at` ms. */
  function scrollTo(scroll: HTMLElement, top: number, at: number): void {
    clock = at;
    scroll.scrollTop = top;
    scroll.dispatchEvent(new Event('scroll'));
  }

  it('measures how fast the reader scrolls it', async () => {
    const { fixture, container } = await renderList({
      messages: [message('$1')],
    });
    const activity = fixture.debugElement.injector.get(TimelineScrollActivity);
    const scroll = scroller(container);

    scrollTo(scroll, 0, 1_000);
    scrollTo(scroll, 500, 1_100);

    expect(activity.speed).toBeCloseTo(5_000);
  });

  it('does not take its own height correction for the reader scrolling fast', async () => {
    const messages = Array.from({ length: 200 }, (_, i) => message(`$${i}`));
    const { fixture, container } = await renderList({ messages });
    const activity = fixture.debugElement.injector.get(TimelineScrollActivity);
    const scroll = scroller(container);
    setScrollGeometry(scroll, {
      clientHeight: 600,
      scrollHeight: 200 * 64,
    });
    // The rows' region starts at the top of the scroller's content.
    scroll.getBoundingClientRect = () => ({ top: 0, bottom: 600 }) as DOMRect;
    const vpad = scroll.querySelector('.vpad') as HTMLElement;
    vpad.getBoundingClientRect = () =>
      ({ top: -scroll.scrollTop, bottom: -scroll.scrollTop }) as DOMRect;
    scrollTo(scroll, 5000, 1_000);
    scrollTo(scroll, 5050, 1_100); // reading: 500 px/s
    fixture.detectChanges();

    // A row above the reader is measured 236 px taller than estimated; the list moves the
    // scroll position by that much to keep the reader in place...
    const row = container.querySelector('[data-mid="$70"]') as Element;
    const [observer] = (
      ResizeObserver as unknown as {
        instances: { observed: Set<Element>; emit(e: unknown[]): void }[];
      }
    ).instances.filter((o) => o.observed.has(row));
    observer.emit([
      {
        target: row,
        borderBoxSize: [{ blockSize: 300, inlineSize: 0 }],
        contentRect: { height: 300 },
      },
    ]);
    expect(scroll.scrollTop).toBe(5050 + 236);
    // ...and the browser reports that with the reader's next 50 px in one event.
    scrollTo(scroll, 5050 + 236 + 50, 1_200);

    expect(activity.speed).toBeCloseTo(500);
  });

  it('starts a new speed estimate in a new room', async () => {
    const { fixture, container } = await renderList({
      messages: [message('$1')],
    });
    const activity = fixture.debugElement.injector.get(TimelineScrollActivity);
    const scroll = scroller(container);
    scrollTo(scroll, 0, 1_000);
    scrollTo(scroll, 800, 1_100);

    fixture.componentRef.setInput('roomId', '!other:hs');
    fixture.detectChanges();

    expect(activity.speed).toBe(0);
  });

  it('watches its rows against its own scroller', async () => {
    const { container } = await renderList({ messages: [message('$1')] });

    const [observer] = TestIntersectionObserver.instances;
    expect(observer.root).toBe(container.querySelector('.scroll'));
  });

  it('follows the "Load images after fast scrolling" flag', async () => {
    const { fixture } = await renderList({ messages: [message('$1')] });
    const gate = fixture.debugElement.injector.get(TimelineMediaGate);
    expect(gate.enabled).toBe(false);

    fixture.componentRef.setInput('deferMediaWhileScrolling', true);
    fixture.detectChanges();
    expect(gate.enabled).toBe(true);

    fixture.componentRef.setInput('deferMediaWhileScrolling', false);
    fixture.detectChanges();
    expect(gate.enabled).toBe(false);
  });

  it('loads a row’s image once a fling settles, with the flag on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fixture, container } = await renderList({
      messages: [message('$1')],
      deferMediaWhileScrolling: true,
    });
    const scroll = scroller(container);
    scrollTo(scroll, 0, 1_000);
    scrollTo(scroll, 800, 1_100);

    // The image's row arrives mid-fling, in view.
    fixture.componentRef.setInput('messages', [
      message('$1'),
      message('$2', PICTURE),
    ]);
    fixture.detectChanges();
    const host = container.querySelector('trn-media-attachment');
    expect(host).not.toBeNull();
    TestIntersectionObserver.instances[0].report(host!, true);
    expect(resolveMedia).not.toHaveBeenCalled();

    // Still for the idle window: the scroll has settled.
    vi.advanceTimersByTime(150);

    expect(resolveMedia).toHaveBeenCalledExactlyOnceWith(PICTURE, 'thumbnail');
    vi.useRealTimers();
  });

  it('holds even the first rows’ images until they are reported near, with the flag on', async () => {
    const { container } = await renderList({
      messages: [message('$1', PICTURE)],
      deferMediaWhileScrolling: true,
    });
    expect(resolveMedia).not.toHaveBeenCalled();

    TestIntersectionObserver.instances[0].report(
      container.querySelector('trn-media-attachment')!,
      true,
    );

    expect(resolveMedia).toHaveBeenCalledExactlyOnceWith(PICTURE, 'thumbnail');
  });

  it('loads a row’s image as it renders, mid-fling, with the flag off', async () => {
    const { fixture, container } = await renderList({
      messages: [message('$1')],
    });
    const scroll = scroller(container);
    scrollTo(scroll, 0, 1_000);
    scrollTo(scroll, 800, 1_100);

    fixture.componentRef.setInput('messages', [
      message('$1'),
      message('$2', PICTURE),
    ]);
    fixture.detectChanges();

    expect(resolveMedia).toHaveBeenCalledExactlyOnceWith(PICTURE, 'thumbnail');
  });
});
