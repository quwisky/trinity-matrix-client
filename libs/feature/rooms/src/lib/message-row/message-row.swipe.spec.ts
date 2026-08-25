import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { MediaService } from '@trinity/data-access/media';
import { UrlPreviewService } from '@trinity/data-access/timeline';
import { PrivacySettingsService } from '@trinity/platform-native';
import { EDGE_ZONE_PX } from '../rooms/drawer-swipe.directive';
import { FileSaveService } from '../media-save/file-save.service';
import {
  MessageRowComponent,
  SWIPE_DEAD_ZONE_PX,
  type MessageRow,
  type MessageRowCaps,
  type SwipeDirection,
} from './message-row.component';

// The long press branches on `isMobileOs()`; the swipe does not — its platform gating is the
// caller's job, and the row is handed a resolved direction. Mocked all the same so a fired
// press takes the mobile path, which is what the arbitration tests are about.
const state = vi.hoisted(() => ({ mobile: true }));
vi.mock('@trinity/platform-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/platform-native')>()),
  isMobileOs: () => state.mobile,
}));

const LONG_PRESS_MS = 500;
/** Wide enough to pass the commit threshold on the width stubbed below. */
const FAR = 200;

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
  swipeDirection: SwipeDirection,
  over: Partial<MessageRowCaps> = {},
  rowOver: Partial<MessageRow> = {},
) {
  const result = await render(MessageRowComponent, {
    inputs: { row: row(rowOver), caps: caps(over), swipeDirection },
    providers: [
      MockProvider(MediaService, {
        resolveMedia: () => of(''),
        downloadMedia: () => of({ blob: new Blob(), filename: 'doc.pdf' }),
      }),
      MockProvider(FileSaveService, { save: () => of(undefined) }),
      MockProvider(UrlPreviewService, { preview: () => of(null) }),
      MockProvider(PrivacySettingsService, {
        linkPreviews: signal(true).asReadonly(),
        linkPreviewsInEncrypted: signal(false).asReadonly(),
      }),
    ],
  });
  const msg = result.container.querySelector('.msg') as HTMLElement;
  // jsdom implements no pointer capture at all, and the row calls it optionally — assigning
  // a spy is both the stub and the assertion.
  const capture = vi.fn();
  msg.setPointerCapture = capture;
  msg.releasePointerCapture = vi.fn();
  // Every row is 400px wide here, so the 25% commit threshold is a round 100px.
  vi.spyOn(msg, 'getBoundingClientRect').mockReturnValue({
    width: 400,
    height: 40,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 400,
    bottom: 40,
    toJSON: () => ({}),
  });
  const swiped: true[] = [];
  const pressed: true[] = [];
  result.fixture.componentInstance.swipe.subscribe(() => swiped.push(true));
  result.fixture.componentInstance.longPress.subscribe(() =>
    pressed.push(true),
  );
  return { ...result, msg, capture, swiped, pressed };
}

/** A touch pointer at (x, y). Explicitly `touch`: jsdom's shim defaults to `mouse`. */
function touch(type: string, x: number, y = 100, over = {}): PointerEvent {
  return new PointerEvent(type, {
    clientX: x,
    clientY: y,
    pointerType: 'touch',
    pointerId: 1,
    isPrimary: true,
    bubbles: true,
    ...over,
  });
}

/** Press, drag, lift — the whole gesture, the way a finger does it. */
function drag(msg: HTMLElement, from: number, to: number, y = 100): void {
  msg.dispatchEvent(touch('pointerdown', from, y));
  msg.dispatchEvent(touch('pointermove', to, y));
  msg.dispatchEvent(touch('pointerup', to, y));
}

const dragged = (msg: HTMLElement) =>
  msg.style.getPropertyValue('--swipe-drag');

describe('MessageRowComponent — the sideways swipe', () => {
  beforeEach(() => {
    state.mobile = true;
    // 1000px wide, so both dead zones are reachable and the middle is not.
    vi.stubGlobal('innerWidth', 1000);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('commits a drag that travels far enough', async () => {
    const { msg, swiped, capture } = await renderRow('right');

    drag(msg, 300, 300 + FAR);

    expect(swiped.length).toBe(1);
    expect(capture).toHaveBeenCalledWith(1);
    // And it puts the row back rather than leaving it parked.
    expect(dragged(msg)).toBe('');
  });

  it('puts the row back when the drag is too short to mean it', async () => {
    const { msg, swiped } = await renderRow('right');

    // 40px on a 400px row — past the slop, so it moves, but under the quarter it commits at.
    drag(msg, 300, 340);

    expect(swiped.length).toBe(0);
    expect(dragged(msg)).toBe('');
  });

  it('moves the row under the finger, in the direction it was given', async () => {
    const { msg } = await renderRow('left');

    msg.dispatchEvent(touch('pointerdown', 300));
    msg.dispatchEvent(touch('pointermove', 250));

    // Left is negative, and the class is what reveals the icon and suspends the ease.
    expect(dragged(msg)).toBe('-50px');
    expect(msg.classList.contains('msg--swiping')).toBe(true);
  });

  it('ignores travel the other way', async () => {
    const { msg, swiped } = await renderRow('right');

    drag(msg, 500, 500 - FAR);

    expect(swiped.length).toBe(0);
    expect(dragged(msg)).toBe('');
  });

  describe('Off', () => {
    it('arms nothing at all', async () => {
      // Off means the gesture does not arm — not that it moves and is then refused. If the
      // row translates here, "Off" has not been implemented, however the drag ends.
      const { msg, swiped, capture } = await renderRow('off');

      msg.dispatchEvent(touch('pointerdown', 300));
      msg.dispatchEvent(touch('pointermove', 300 + FAR));

      expect(dragged(msg)).toBe('');
      expect(msg.classList.contains('msg--swiping')).toBe(false);
      expect(capture).not.toHaveBeenCalled();

      msg.dispatchEvent(touch('pointerup', 300 + FAR));
      expect(swiped.length).toBe(0);
    });
  });

  describe('the dead zones', () => {
    it('refuses to start within the zone at the left edge', async () => {
      const { msg, swiped, capture } = await renderRow('right');

      drag(msg, SWIPE_DEAD_ZONE_PX - 1, SWIPE_DEAD_ZONE_PX - 1 + FAR);

      expect(swiped.length).toBe(0);
      expect(capture).not.toHaveBeenCalled();
    });

    it('refuses to start within the zone at the right edge', async () => {
      const { msg, swiped } = await renderRow('left');

      const start = 1000 - SWIPE_DEAD_ZONE_PX + 1;
      drag(msg, start, start - FAR);

      expect(swiped.length).toBe(0);
    });

    it('allows a drag that starts outside and travels into an edge', async () => {
      // These are edge-START recognisers, so nothing takes the gesture away mid-drag.
      const { msg, swiped } = await renderRow('right');

      drag(msg, 500, 999);

      expect(swiped.length).toBe(1);
    });

    it('is never narrower than the drawer’s own edge zone', () => {
      // The drawer's opening drag starts within `EDGE_ZONE_PX` of the right edge. If this
      // zone were the narrower of the two, a swipe could arm inside it and the two gestures
      // would run on the same finger. One constant, read by both edges, and pinned here so
      // the pair cannot drift — `MainViewController.swift` already anticipates the drawer's
      // zone moving inward.
      expect(SWIPE_DEAD_ZONE_PX).toBeGreaterThanOrEqual(EDGE_ZONE_PX);
    });
  });

  describe('what it refuses', () => {
    it('does nothing for a mouse', async () => {
      const { msg, swiped } = await renderRow('right');

      msg.dispatchEvent(
        touch('pointerdown', 300, 100, { pointerType: 'mouse' }),
      );
      msg.dispatchEvent(
        touch('pointermove', 300 + FAR, 100, { pointerType: 'mouse' }),
      );
      msg.dispatchEvent(
        touch('pointerup', 300 + FAR, 100, { pointerType: 'mouse' }),
      );

      expect(swiped.length).toBe(0);
      expect(dragged(msg)).toBe('');
    });

    it('does not arm on a second finger', async () => {
      const { msg, swiped } = await renderRow('right');

      msg.dispatchEvent(touch('pointerdown', 300, 100, { isPrimary: false }));
      msg.dispatchEvent(touch('pointermove', 300 + FAR));
      msg.dispatchEvent(touch('pointerup', 300 + FAR));

      expect(swiped.length).toBe(0);
    });

    it('abandons a drag that turns vertical', async () => {
      const { msg, swiped } = await renderRow('right');

      msg.dispatchEvent(touch('pointerdown', 300, 100));
      msg.dispatchEvent(touch('pointermove', 340, 140));
      msg.dispatchEvent(touch('pointermove', 300 + FAR, 140));
      msg.dispatchEvent(touch('pointerup', 300 + FAR, 140));

      expect(swiped.length).toBe(0);
      expect(dragged(msg)).toBe('');
    });

    it('drops the drag when the browser cancels the pointer', async () => {
      const { msg, swiped } = await renderRow('right');

      msg.dispatchEvent(touch('pointerdown', 300));
      msg.dispatchEvent(touch('pointermove', 300 + FAR));
      msg.dispatchEvent(touch('pointercancel', 300 + FAR));

      expect(dragged(msg)).toBe('');
      expect(swiped.length).toBe(0);
    });
  });

  describe('rows the long press skips', () => {
    // The long press bails on media and on rows with no toolbar. The swipe does not share
    // either bail, and these are the rows whose swipe means Reply — the gesture being dead
    // on them is most of the timeline.
    it('still swipes a row that failed to decrypt', async () => {
      const { msg, swiped } = await renderRow(
        'right',
        {},
        { decryptionFailed: true },
      );

      drag(msg, 300, 300 + FAR);

      expect(swiped.length).toBe(1);
    });

    it('still swipes a redacted row', async () => {
      const { msg, swiped } = await renderRow(
        'right',
        {},
        { kind: 'redacted' },
      );

      drag(msg, 300, 300 + FAR);

      expect(swiped.length).toBe(1);
    });
  });

  describe('against the long press', () => {
    it('cancels a pending press once the drag is real', async () => {
      vi.useFakeTimers();
      const { msg, swiped, pressed } = await renderRow('right');

      msg.dispatchEvent(touch('pointerdown', 300));
      msg.dispatchEvent(touch('pointermove', 300 + FAR));
      // The press would have fired here had the drag not taken it.
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
      msg.dispatchEvent(touch('pointerup', 300 + FAR));

      expect(pressed.length).toBe(0);
      expect(swiped.length).toBe(1);
    });

    it('disarms the drag once the press has fired', async () => {
      // Press, PAUSE past the threshold, then drag. The press cancels on travel only while
      // its timer is live, so without the disarm the sheet opens and the swipe then commits
      // underneath its own backdrop — two actions from one gesture.
      vi.useFakeTimers();
      const { msg, swiped, pressed } = await renderRow('right');

      msg.dispatchEvent(touch('pointerdown', 300));
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
      msg.dispatchEvent(touch('pointermove', 300 + FAR));
      msg.dispatchEvent(touch('pointerup', 300 + FAR));

      expect(pressed.length).toBe(1);
      expect(swiped.length).toBe(0);
    });
  });

  describe('the affordance', () => {
    it('offers the pencil on a row that can be edited', async () => {
      const { container } = await renderRow('right', { editable: true });

      // The icon's `name` is an INPUT, not an attribute, so it is unreadable from the DOM —
      // and the icon registry is not loaded in this harness anyway. The row publishes the
      // resolved action instead, which is what the e2e reads too.
      expect(
        container
          .querySelector('.msg__swipe')
          ?.getAttribute('data-swipe-action'),
      ).toBe('edit');
    });

    it('offers the reply arrow on every other row', async () => {
      const { container } = await renderRow('right', { editable: false });

      expect(
        container
          .querySelector('.msg__swipe')
          ?.getAttribute('data-swipe-action'),
      ).toBe('reply');
    });

    it('renders no icon at all while the gesture is off', async () => {
      const { container } = await renderRow('off');

      expect(container.querySelector('.msg__swipe')).toBeNull();
    });
  });
});
