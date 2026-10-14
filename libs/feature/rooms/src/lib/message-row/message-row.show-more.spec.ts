import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

/** Render one row as a list would: its observer says whether the body is long. */
async function renderRow(options: { long: boolean; store?: boolean }) {
  const long = signal(options.long);
  const overflow = {
    overflowing: vi.fn(() => long.asReadonly()),
    observe: vi.fn(),
    unobserve: vi.fn(),
    clear: vi.fn(),
  };
  const result = await render(MessageRowComponent, {
    inputs: { row: row() },
    providers: [
      { provide: BodyOverflowObserver, useValue: overflow },
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
