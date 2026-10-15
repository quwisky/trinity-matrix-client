import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MediaPipeline,
  type PresentedMediaReference,
} from '@trinity/data-access/media';
import { ExpandedBodiesStore } from '../rooms/expanded-bodies.store';
import { RoomShellStore } from '../rooms/room-shell-store';
import { BodyOverflowObserver } from './body-overflow';
import { MessageRowComponent, type MessageRow } from './message-row.component';

function row(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: '$1',
    senderId: '@a:hs',
    senderName: 'Alice',
    senderInitial: 'A',
    senderAvatarMxc: null,
    body: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'),
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
    showHeader: true,
    ...overrides,
  };
}

const fileMedia = {
  id: 'presented-media-file',
  kind: 'file',
  filename: 'doc.pdf',
  mimeType: 'application/pdf',
} as PresentedMediaReference;

/**
 * Render one row as a list would: its observer says whether the body is long. `store: false`
 * leaves out the rooms page and `observer: false` the list, as rows rendered elsewhere are;
 * `observer: 'real'` gives the row the list's own observer instead of a stand-in.
 */
async function renderRow(options: {
  long: boolean;
  store?: boolean;
  observer?: boolean | 'real';
  row?: Partial<MessageRow>;
}) {
  const long = signal(options.long);
  const release = vi.fn();
  const overflow = {
    hold: vi.fn(() => ({ long: long.asReadonly(), release })),
    observe: vi.fn(),
    unobserve: vi.fn(),
    clear: vi.fn(),
  };
  const result = await render(MessageRowComponent, {
    inputs: { row: row(options.row) },
    providers: [
      // The media branch renders <trn-media-attachment>, which resolves through this.
      MockProvider(MediaPipeline, { resolveMedia: () => of('') }),
      ...(options.observer === false
        ? []
        : options.observer === 'real'
          ? [BodyOverflowObserver]
          : [{ provide: BodyOverflowObserver, useValue: overflow }]),
      ...(options.store === false
        ? []
        : [
            ExpandedBodiesStore,
            MockProvider(RoomShellStore, {
              activeAccountId: signal<string | null>('@me:hs'),
              activeRoomId: signal<string | null>('!r:hs'),
            }),
          ]),
    ],
  });
  const clamp = () =>
    result.container.querySelector('.msg__clamp') as HTMLElement;
  const button = () =>
    result.container.querySelector<HTMLButtonElement>(
      '[data-testid="msg-show-more"]',
    );
  return { ...result, clamp, button, overflow, release };
}

describe('MessageRowComponent — Show more', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows a body that fits whole, under the 24-line cap, with no button', async () => {
    const { clamp, button } = await renderRow({ long: false });

    expect(button()).toBeNull();
    expect(clamp().classList.contains('msg__clamp--capped')).toBe(true);
    expect(clamp().classList.contains('msg__clamp--collapsed')).toBe(false);
  });

  it('collapses a long body behind Show more, pointing the button at it', async () => {
    const { clamp, button } = await renderRow({ long: true });

    expect(button()?.textContent?.trim()).toBe('Show more');
    expect(button()?.getAttribute('type')).toBe('button');
    expect(button()?.getAttribute('aria-expanded')).toBe('false');
    expect(clamp().id).toMatch(/^msg-body-\d+$/);
    expect(button()?.getAttribute('aria-controls')).toBe(clamp().id);
    expect(clamp().classList.contains('msg__clamp--collapsed')).toBe(true);
    // Collapsed text stays in the document, for assistive technology and copies.
    expect(clamp().textContent).toContain('line 40');
  });

  it('expands and collapses through the rooms page store, keeping focus on the button', async () => {
    const { clamp, button, fixture } = await renderRow({ long: true });
    const store = TestBed.inject(ExpandedBodiesStore);
    const control = button()!;
    control.focus();

    fireEvent.click(control);
    fixture.detectChanges();

    expect(store.isExpanded('$1')).toBe(true);
    expect(button()).toBe(control);
    expect(control.textContent?.trim()).toBe('Show less');
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(clamp().classList.contains('msg__clamp--collapsed')).toBe(false);
    expect(document.activeElement).toBe(control);

    fireEvent.click(control);
    fixture.detectChanges();

    expect(store.isExpanded('$1')).toBe(false);
    expect(document.activeElement).toBe(control);
  });

  it('keeps the plain body exact inside the wrapper, with no added whitespace', async () => {
    const { clamp } = await renderRow({ long: true });

    // The plain body is pre-wrap: a space around the text would show as one.
    expect(clamp().querySelector('.msg__text')?.textContent).toBe(row().body);
  });

  it('starts expanded when the store already holds the row', async () => {
    const { button, fixture } = await renderRow({ long: true });

    TestBed.inject(ExpandedBodiesStore).expand('$1');
    fixture.detectChanges();

    expect(button()?.textContent?.trim()).toBe('Show less');
  });

  // The list's observer keeps a row's measurement only while something needs it, so the row
  // holds its id for as long as it reads it, and lets go when it goes (#1361).
  it('holds its measurement while rendered and lets go when it goes', async () => {
    const { fixture, overflow, release } = await renderRow({ long: true });

    expect(overflow.hold).toHaveBeenCalledWith('$1');
    expect(release).not.toHaveBeenCalled();

    fixture.destroy();

    expect(release).toHaveBeenCalledTimes(1);
  });

  // The list's own observer, not a stand-in: an edit swaps the plain body for a formatted one,
  // and the row keeps following the measurement it holds, then leaves nothing behind.
  it('follows its body through the list observer across an edit, and leaves no entry', async () => {
    const { fixture, button } = await renderRow({
      long: false,
      observer: 'real',
    });
    const overflow = fixture.debugElement.injector.get(BodyOverflowObserver);
    const report = (height: number) => {
      const body = fixture.nativeElement.querySelector(
        '.msg__clamp > .msg__text',
      ) as HTMLElement;
      const observer = (
        ResizeObserver as unknown as {
          instances: { observed: Set<Element>; emit(e: unknown[]): void }[];
        }
      ).instances.find((candidate) => candidate.observed.has(body));
      observer?.emit([
        { target: body, contentBoxSize: [{ blockSize: height }] },
      ]);
      fixture.detectChanges();
    };

    report(40 * 24);
    expect(button()?.textContent?.trim()).toBe('Show more');

    fixture.componentRef.setInput(
      'row',
      row({ html: '<p>short <strong>edit</strong></p>', body: 'short edit' }),
    );
    fixture.detectChanges();
    report(2 * 24);
    expect(button()).toBeNull();

    fixture.destroy();
    expect(overflow['entries'].size).toBe(0);
  });

  it('never clamps where no rooms page keeps the state', async () => {
    const { clamp, button } = await renderRow({ long: true, store: false });

    expect(button()).toBeNull();
    expect(clamp().classList.contains('msg__clamp--capped')).toBe(false);
    expect(clamp().classList.contains('msg__clamp--collapsed')).toBe(false);
  });

  it('never clamps where no list measures the body', async () => {
    const { clamp, button } = await renderRow({ long: true, observer: false });

    expect(button()).toBeNull();
    expect(clamp().classList.contains('msg__clamp--capped')).toBe(false);
    expect(clamp().classList.contains('msg__clamp--collapsed')).toBe(false);
  });

  it('collapses a formatted body inside the wrapper', async () => {
    const { clamp, button } = await renderRow({
      long: true,
      row: { html: '<p>formatted <strong>text</strong></p>' },
    });

    expect(clamp().querySelector('.msg__text--html strong')).toBeTruthy();
    expect(clamp().classList.contains('msg__clamp--collapsed')).toBe(true);
    expect(button()).toBeTruthy();
  });

  it('collapses a caption inside the wrapper, below its attachment', async () => {
    const { clamp, container } = await renderRow({
      long: true,
      row: { kind: 'file', media: fileMedia, caption: 'look at this' },
    });

    expect(container.querySelector('trn-media-attachment')).toBeTruthy();
    expect(clamp().querySelector('.msg__text')?.textContent).toBe(
      'look at this',
    );
    expect(clamp().classList.contains('msg__clamp--collapsed')).toBe(true);
  });

  it('renders no wrapper for an attachment without a caption', async () => {
    const { container, button } = await renderRow({
      long: true,
      row: { kind: 'file', media: fileMedia, caption: null, captionHtml: null },
    });

    expect(container.querySelector('trn-media-attachment')).toBeTruthy();
    expect(container.querySelector('.msg__clamp')).toBeNull();
    expect(button()).toBeNull();
  });

  /** Focus `element` as the keyboard (`:focus-visible`) or a mouse press (not) would. */
  function focusAs(element: HTMLElement, visible: boolean): void {
    // jsdom matches :focus-visible whenever an element has focus, so the mouse case is stubbed.
    const matches = element.matches.bind(element);
    vi.spyOn(element, 'matches').mockImplementation((selector) =>
      selector === ':focus-visible' ? visible : matches(selector),
    );
    element.focus();
  }

  const linkPastTheCut = {
    html: '<p>start</p><p><a href="https://example.org/">a link past the cut</a></p>',
  };

  it('expands a collapsed body when keyboard focus moves into it, so a link past the cut shows', async () => {
    const { clamp, button, fixture } = await renderRow({
      long: true,
      row: linkPastTheCut,
    });
    const link = clamp().querySelector<HTMLAnchorElement>('a')!;

    focusAs(link, true);
    fixture.detectChanges();

    expect(TestBed.inject(ExpandedBodiesStore).isExpanded('$1')).toBe(true);
    expect(clamp().classList.contains('msg__clamp--collapsed')).toBe(false);
    expect(button()?.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(link);
  });

  it('keeps a body collapsed when a mouse press focuses a link in it, so the click lands', async () => {
    const { clamp, fixture } = await renderRow({
      long: true,
      row: linkPastTheCut,
    });

    focusAs(clamp().querySelector<HTMLAnchorElement>('a')!, false);
    fixture.detectChanges();

    expect(TestBed.inject(ExpandedBodiesStore).isExpanded('$1')).toBe(false);
    expect(clamp().classList.contains('msg__clamp--collapsed')).toBe(true);
  });

  it('leaves the state alone when focus moves into a body that is not collapsed', async () => {
    const { clamp, fixture } = await renderRow({
      long: false,
      row: { html: '<p><a href="https://example.org/">a link</a></p>' },
    });

    clamp().querySelector<HTMLAnchorElement>('a')!.focus();
    fixture.detectChanges();

    expect(TestBed.inject(ExpandedBodiesStore).expanded().size).toBe(0);
  });

  it('scrolls the row back into view when collapsing leaves its top above the list', async () => {
    const { button, container, fixture } = await renderRow({ long: true });
    container.setAttribute('data-message-scroller', '');
    const message = container.querySelector<HTMLElement>('.msg')!;
    const scrollIntoView = vi.fn();
    message.scrollIntoView = scrollIntoView;
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      top: 0,
    } as DOMRect);
    vi.spyOn(message, 'getBoundingClientRect').mockReturnValue({
      top: -400,
    } as DOMRect);

    fireEvent.click(button()!);
    fixture.detectChanges();
    expect(scrollIntoView).not.toHaveBeenCalled();

    fireEvent.click(button()!);

    await vi.waitFor(
      () => {
        fixture.detectChanges();
        expect(scrollIntoView).toHaveBeenCalledWith({
          block: 'start',
          behavior: expect.any(String),
        });
      },
      { timeout: 1_000 },
    );
  });
});
