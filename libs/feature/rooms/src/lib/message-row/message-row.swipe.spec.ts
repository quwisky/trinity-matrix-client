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

/** How far along the gesture is, 0 → 1, as the affordance reads it. */
const progress = (msg: HTMLElement) =>
  Number(msg.style.getPropertyValue('--swipe-progress') || 0);

const armed = (msg: HTMLElement) => msg.classList.contains('msg--swipe-armed');

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

  describe('the reveal', () => {
    // The affordance has to arrive WITH the drag, not at the first pixel. #222 asks for the
    // icon to say which action is coming "early enough in the drag to abandon it", and an
    // affordance that snaps to full strength immediately says nothing about how close the
    // commit is — the reader finds the threshold by crossing it.
    it('grows with the drag rather than appearing whole', async () => {
      const { msg } = await renderRow('right');

      msg.dispatchEvent(touch('pointerdown', 300));
      msg.dispatchEvent(touch('pointermove', 325));
      const quarter = progress(msg);
      msg.dispatchEvent(touch('pointermove', 350));
      const half = progress(msg);

      // 400px row, 25% threshold → 100px. 25px in is a quarter of the way, 50px is half.
      expect(quarter).toBeGreaterThan(0);
      expect(quarter).toBeLessThan(1);
      expect(half).toBeGreaterThan(quarter);
      expect(armed(msg)).toBe(false);
    });

    it('arms once the drag would commit', async () => {
      const { msg } = await renderRow('right');

      msg.dispatchEvent(touch('pointerdown', 300));
      msg.dispatchEvent(touch('pointermove', 399));
      expect(armed(msg)).toBe(false);

      msg.dispatchEvent(touch('pointermove', 400));
      expect(progress(msg)).toBe(1);
      expect(armed(msg)).toBe(true);
    });

    it('disarms if the drag falls back under the threshold', async () => {
      // Abandoning has to be visible too: a reader who pulls back must see the action leave.
      const { msg } = await renderRow('right');

      msg.dispatchEvent(touch('pointerdown', 300));
      msg.dispatchEvent(touch('pointermove', 420));
      expect(armed(msg)).toBe(true);

      msg.dispatchEvent(touch('pointermove', 340));
      expect(armed(msg)).toBe(false);
      expect(progress(msg)).toBeLessThan(1);
    });

    it('clears the reveal when the gesture ends', async () => {
      const { msg } = await renderRow('right');

      drag(msg, 300, 420);

      expect(progress(msg)).toBe(0);
      expect(armed(msg)).toBe(false);
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

    it('does not swipe a read-only row', async () => {
      // The one row where NEITHER outcome exists: no composer to reply or edit into. The
      // long press skips it via `toolbar()`, which this gesture deliberately does not use,
      // so the exemption is re-made rather than inherited.
      const { msg, swiped } = await renderRow('right', { readOnly: true });

      drag(msg, 300, 300 + FAR);

      expect(swiped.length).toBe(0);
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
    it('does not fire the press when the drag moves off', async () => {
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

  it('captures the pointer on the row, not on whatever was under the finger', async () => {
    // `event.target` is the DEEPEST hit element — a link, a reaction pill, an avatar — and a
    // capture dies with its target. `trn-avatar` swaps its `<span>` initial for an `<img>`
    // the moment the image loads, so a finger that went down on an initial would lose the
    // capture mid-drag, never see `pointerup`, and leave the row parked. Dispatching from a
    // descendant is what makes the distinction visible at all: dispatching on `.msg`, as
    // every other test here does, makes `target` and `currentTarget` the same element.
    const { msg, capture } = await renderRow('right');
    const child = msg.querySelector('.msg__body') ?? msg.firstElementChild;
    const childCapture = vi.fn();
    (child as HTMLElement).setPointerCapture = childCapture;

    child?.dispatchEvent(touch('pointerdown', 300));

    expect(capture).toHaveBeenCalledWith(1);
    expect(childCapture).not.toHaveBeenCalled();
  });

  describe('the commit threshold', () => {
    // `FAR` alone does not pin it: at 2x the threshold, raising the fraction from a quarter
    // to a HALF left every test green — so the effort the gesture demands could have been
    // doubled silently. These two straddle it against the stubbed 400px row.
    it('commits at exactly the threshold', async () => {
      const { msg, swiped } = await renderRow('right');

      drag(msg, 100, 200);

      expect(swiped.length).toBe(1);
    });

    it('does not commit one pixel short of it', async () => {
      const { msg, swiped } = await renderRow('right');

      drag(msg, 100, 199);

      expect(swiped.length).toBe(0);
    });
  });

  describe('what the drawer sees', () => {
    // The row sits inside the drawer's gesture host, which arms on ANY `pointerdown` while
    // it is open. Stopping propagation is what keeps a thread reply's swipe from also
    // closing the drawer — and it must not be stopped in any other case, or the drawer
    // becomes unreachable from the timeline.
    async function pointerDownReachesParent(
      direction: SwipeDirection,
      x: number,
      over = {},
    ): Promise<boolean> {
      const { msg } = await renderRow(direction);
      let reached = false;
      const parent = msg.parentElement as HTMLElement;
      parent.addEventListener('pointerdown', () => {
        reached = true;
      });
      msg.dispatchEvent(touch('pointerdown', x, 100, over));
      return reached;
    }

    it('takes the press away from the drawer once the swipe arms', async () => {
      expect(await pointerDownReachesParent('right', 300)).toBe(false);
    });

    it('leaves it alone while the gesture is off', async () => {
      expect(await pointerDownReachesParent('off', 300)).toBe(true);
    });

    it('leaves it alone inside the dead zone', async () => {
      expect(await pointerDownReachesParent('right', 4)).toBe(true);
    });

    it('leaves it alone for a mouse', async () => {
      expect(
        await pointerDownReachesParent('right', 300, { pointerType: 'mouse' }),
      ).toBe(true);
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

    // A leftward drag opens a strip on the RIGHT, so the icon has to park there. The first
    // version used `justify-content: space-between` with a single child, which pins it to
    // the inline start whichever way the row moves — measured in a browser as the icon
    // painting over the message text while the opened strip stayed empty. jsdom applies no
    // CSS, so the class is as far as this level can go; the geometry is the browser's job.
    const parksAtEnd = (container: HTMLElement) =>
      container
        .querySelector('.msg__swipe')
        ?.classList.contains('msg__swipe--end');

    it('waits at the right-hand end for a leftward drag', async () => {
      const { container } = await renderRow('left');

      expect(parksAtEnd(container)).toBe(true);
    });

    it('waits at the left-hand end for a rightward drag', async () => {
      const { container } = await renderRow('right');

      expect(parksAtEnd(container)).toBe(false);
    });

    it('renders nothing on a read-only row', async () => {
      const { container } = await renderRow('right', { readOnly: true });

      expect(container.querySelector('.msg__swipe')).toBeNull();
    });

    it('renders no icon at all while the gesture is off', async () => {
      const { container } = await renderRow('off');

      expect(container.querySelector('.msg__swipe')).toBeNull();
    });
  });
});
