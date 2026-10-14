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
 * leaves out the rooms page and `observer: false` the list, as rows rendered elsewhere are.
 */
async function renderRow(options: {
  long: boolean;
  store?: boolean;
  observer?: boolean;
  row?: Partial<MessageRow>;
}) {
  const long = signal(options.long);
  const overflow = {
    overflowing: vi.fn(() => long.asReadonly()),
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
  return { ...result, clamp, button };
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

  it('expands a collapsed body when focus moves into it, so a link past the cut shows', async () => {
    const { clamp, button, fixture } = await renderRow({
      long: true,
      row: {
        html: '<p>start</p><p><a href="https://example.org/">a link past the cut</a></p>',
      },
    });
    const link = clamp().querySelector<HTMLAnchorElement>('a')!;

    link.focus();
    fixture.detectChanges();

    expect(TestBed.inject(ExpandedBodiesStore).isExpanded('$1')).toBe(true);
    expect(clamp().classList.contains('msg__clamp--collapsed')).toBe(false);
    expect(button()?.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(link);
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
