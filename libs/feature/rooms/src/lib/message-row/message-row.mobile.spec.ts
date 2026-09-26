import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { MediaService } from '@trinity/data-access/media';
import { UrlPreviewService } from '@trinity/data-access/timeline';
import { PrivacySettingsService } from '@trinity/platform-native';
import { HostFileExportService } from '@trinity/runtime/host';
import {
  MessageRowComponent,
  type MessageLongPressContext,
  type MessageRow,
  type MessageRowCaps,
} from './message-row.component';

// `isMobileOs` is a plain exported function, so the whole barrel is mocked and the rest of
// it passed through. Hoisted by vitest above the imports, which is why the flag it reads is
// declared with `vi.hoisted` rather than as an ordinary `let`.
const state = vi.hoisted(() => ({ mobile: false }));
vi.mock('@trinity/platform-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/platform-native')>()),
  isMobileOs: () => state.mobile,
}));

const LONG_PRESS_MS = 500;

const caps = (over: Partial<MessageRowCaps> = {}): MessageRowCaps => ({
  editable: false,
  deletable: false,
  canPin: false,
  pinned: false,
  canThread: true,
  canQuote: true,
  readOnly: false,
  ...over,
});

function row(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: '$1',
    senderId: '@a:hs',
    senderName: 'Alice',
    senderInitial: 'A',
    senderAvatarMxc: null,
    body: 'hello',
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
    ...over,
  };
}

async function renderRow(
  over: Partial<MessageRowCaps> = {},
  overRow: Partial<MessageRow> = {},
) {
  const result = await render(MessageRowComponent, {
    inputs: { row: row(overRow), caps: caps(over) },
    providers: [
      MockProvider(MediaService, {
        resolveMedia: () => of(''),
        downloadMedia: () => of({ blob: new Blob(), filename: 'doc.pdf' }),
      }),
      MockProvider(HostFileExportService, {
        save: () => of({ kind: 'completed' as const }),
      }),
      MockProvider(UrlPreviewService, { preview: () => of(null) }),
      MockProvider(PrivacySettingsService, {
        linkPreviews: signal(true).asReadonly(),
        linkPreviewsInEncrypted: signal(false).asReadonly(),
      }),
    ],
  });
  const pressed: MessageLongPressContext[] = [];
  result.fixture.componentInstance.longPress.subscribe((context) =>
    pressed.push(context),
  );
  return { ...result, pressed };
}

/** Press and hold past the threshold, the way a finger does. */
function longPress(container: HTMLElement): void {
  const msg = container.querySelector('.msg') as HTMLElement;
  msg.dispatchEvent(
    new PointerEvent('pointerdown', {
      isPrimary: true,
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
      bubbles: true,
    }),
  );
  vi.advanceTimersByTime(LONG_PRESS_MS + 10);
  // The reveal is a signal; the class only lands on the next pass.
  TestBed.tick();
}

const revealed = (container: HTMLElement) =>
  container.querySelector('.msg')?.classList.contains('msg--revealed') ?? false;

describe('MessageRowComponent — the long press on a mobile OS', () => {
  afterEach(() => {
    state.mobile = false;
    vi.useRealTimers();
  });

  it('cancels a touch on the padding surface without canceling body selection', async () => {
    state.mobile = true;
    const { container } = await renderRow();
    const msg = container.querySelector('.msg') as HTMLElement;
    const padding = msg.querySelector('.msg__padding-touch') as HTMLElement;
    const body = msg.querySelector('.msg__text') as HTMLElement;
    const pointerDown = (target: HTMLElement) => {
      const event = new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        isPrimary: true,
        pointerType: 'touch',
      });
      target.dispatchEvent(event);
      return event;
    };

    expect(padding?.parentElement).toBe(msg);
    expect(padding.getAttribute('aria-hidden')).toBe('true');
    expect(pointerDown(padding).defaultPrevented).toBe(true);
    expect(pointerDown(body).defaultPrevented).toBe(false);
  });

  it('does not put a padding hit surface on desktop rows', async () => {
    state.mobile = false;
    const { container } = await renderRow();

    expect(container.querySelector('.msg__padding-touch')).toBeNull();
  });

  it.each([
    ['read-only', { readOnly: true }, {}],
    ['redacted', {}, { kind: 'redacted' }],
    ['decryption-failed', {}, { decryptionFailed: true }],
  ] as const)(
    'does not make padding nonselectable on %s rows',
    async (_name, rowCaps, rowView) => {
      state.mobile = true;
      const { container } = await renderRow(rowCaps, rowView);

      expect(container.querySelector('.msg__padding-touch')).toBeNull();
    },
  );

  it('cancels text selection only for a primary touch on bare row padding', async () => {
    state.mobile = true;
    vi.useFakeTimers();
    const { container, pressed } = await renderRow();
    const msg = container.querySelector('.msg') as HTMLElement;
    const body = container.querySelector('.msg__text') as HTMLElement;
    const pointerDown = (target: HTMLElement, over: PointerEventInit = {}) => {
      const event = new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        isPrimary: true,
        pointerType: 'touch',
        clientX: 10,
        clientY: 10,
        ...over,
      });
      target.dispatchEvent(event);
      return event;
    };

    expect(pointerDown(body).defaultPrevented).toBe(false);
    msg.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(pointerDown(msg, { isPrimary: false }).defaultPrevented).toBe(false);
    expect(pointerDown(msg, { pointerType: 'pen' }).defaultPrevented).toBe(
      false,
    );
    expect(pointerDown(msg).defaultPrevented).toBe(true);

    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    TestBed.tick();
    expect(pressed).toEqual([{ anchor: msg, clientY: 10 }]);
  });

  it('keeps bare row padding selectable when the row has no actions', async () => {
    state.mobile = true;
    const { container } = await renderRow({ readOnly: true });
    const event = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      isPrimary: true,
      pointerType: 'touch',
    });

    container.querySelector('.msg')?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('asks the host for a sheet instead of revealing the bar', async () => {
    // The bar is what the platform cannot use: it covers the message it acts on, a stray
    // scroll dismisses it, and its reaction picker opens off the top of the scroller.
    state.mobile = true;
    vi.useFakeTimers();
    const { container, pressed } = await renderRow();

    expect(container.querySelector('.msg__toolbar')).toBeNull();

    longPress(container);

    expect(pressed.length).toBe(1);
    expect(pressed[0]).toEqual({
      anchor: container.querySelector('.msg'),
      clientY: 10,
    });
    expect(revealed(container)).toBe(false);
  });

  it('still reveals the bar everywhere else', async () => {
    // The hover bar is right for a mouse, and none of the mobile defects exist there.
    state.mobile = false;
    vi.useFakeTimers();
    const { container, pressed } = await renderRow();

    longPress(container);

    expect(pressed.length).toBe(0);
    expect(revealed(container)).toBe(true);
  });

  it('offers nothing at all on a row with no actions', async () => {
    // The explicit action-capability predicate is what keeps the gesture off read-only,
    // redacted and decryption-failed rows now that mobile does not render a toolbar.
    state.mobile = true;
    vi.useFakeTimers();
    const { container, pressed } = await renderRow({ readOnly: true });

    longPress(container);

    expect(pressed.length).toBe(0);
    expect(revealed(container)).toBe(false);
  });

  it('leaves a link its own menu rather than opening ours behind it', async () => {
    // A long press on a link or an attachment belongs to the browser — "Open in new tab",
    // "Save image" live nowhere else. `onContextMenu` has always guarded this; the touch
    // path did not, so the same press raised the OS menu AND opened ours underneath.
    state.mobile = true;
    vi.useFakeTimers();
    const { container, pressed } = await renderRow();
    const msg = container.querySelector('.msg') as HTMLElement;
    const link = document.createElement('a');
    link.href = 'https://example.invalid';
    msg.append(link);

    const event = new PointerEvent('pointerdown', {
      isPrimary: true,
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
      bubbles: true,
      cancelable: true,
    });
    link.dispatchEvent(event);
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    TestBed.tick();

    expect(event.defaultPrevented).toBe(false);
    expect(pressed.length).toBe(0);
    expect(revealed(container)).toBe(false);
  });

  it('swallows the native menu without opening a second one', async () => {
    // Android fires `contextmenu` at the end of a long press, so it lands right after the
    // sheet has. Suppressing the browser's own menu is still wanted; stacking the overflow
    // menu on top of the sheet is not.
    state.mobile = true;
    const { container, fixture } = await renderRow();
    // Mobile has no inaccessible hidden toolbar to open or reserve layout space for.
    const bar = (
      fixture.componentInstance as unknown as {
        toolbar: () => { openMoreMenu: () => void } | undefined;
      }
    ).toolbar();
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });

    container.querySelector('.msg')?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(bar).toBeUndefined();
  });

  it('still opens the overflow menu on a right-click everywhere else', async () => {
    state.mobile = false;
    const { container, fixture } = await renderRow();
    // `toolbar` is a private viewChild; reached the same way `message-list-base.spec.ts`
    // reaches its protected members, because what is being asserted is the collaboration.
    const bar = (
      fixture.componentInstance as unknown as {
        toolbar: () => { openMoreMenu: () => void } | undefined;
      }
    ).toolbar();
    const openMore = vi.spyOn(bar!, 'openMoreMenu');

    container
      .querySelector('.msg')
      ?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );

    expect(openMore).toHaveBeenCalledTimes(1);
  });
});
