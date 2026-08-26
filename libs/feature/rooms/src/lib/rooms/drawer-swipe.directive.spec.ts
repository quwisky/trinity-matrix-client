import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DrawerSwipeDirective,
  EDGE_ZONE_PX,
  NATIVE_HISTORY_EDGE_PX,
} from './drawer-swipe.directive';

/**
 * The gesture's decisions, which is all a unit test can reach.
 *
 * jsdom has no layout and no real touch, so what is pinned here is the ARITHMETIC — where a
 * gesture may start, when it commits, when it is abandoned as a scroll — and the promise the
 * directive makes to the rest of the app: that a drag writes a custom property and nothing
 * else until it has decided. Whether the drawer visually follows is CSS, and the phone-viewport
 * Playwright spec is what sees that.
 */
@Component({
  imports: [DrawerSwipeDirective],
  template: `
    <div data-shell-root>
      <div
        trnDrawerSwipe
        [drawerEnabled]="enabled()"
        [drawerOpen]="open()"
        [drawerWidth]="240"
        (opened)="events.push('opened')"
        (closed)="events.push('closed')"
      ></div>
    </div>
  `,
})
class HostComponent {
  readonly enabled = signal(true);
  readonly open = signal(false);
  readonly events: string[] = [];
}

const OPENING_BAND_X =
  400 - NATIVE_HISTORY_EDGE_PX - Math.floor(EDGE_ZONE_PX / 2);

/** A touch pointer at (x, y), `at` ms into the gesture. */
function touch(type: string, x: number, y = 100, at = 0): PointerEvent {
  const event = new PointerEvent(type, {
    clientX: x,
    clientY: y,
    pointerType: 'touch',
    pointerId: 1,
    bubbles: true,
  });
  // `timeStamp` is read-only and always 0 in jsdom; the directive divides by it for velocity.
  Object.defineProperty(event, 'timeStamp', { value: at });
  return event;
}

describe('DrawerSwipeDirective', () => {
  let target: HTMLElement;
  let shell: HTMLElement;
  let host: HostComponent;

  beforeEach(async () => {
    // The edge zone is measured from the viewport's right edge.
    vi.stubGlobal('innerWidth', 400);
    const { container, fixture } = await render(HostComponent);
    target = container.querySelector('[trnDrawerSwipe]') as HTMLElement;
    shell = container.querySelector('[data-shell-root]') as HTMLElement;
    host = fixture.componentInstance;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const drag = (from: number, to: number, ms = 400) => {
    target.dispatchEvent(touch('pointerdown', from, 100, 0));
    target.dispatchEvent(touch('pointermove', to, 100, ms));
    target.dispatchEvent(touch('pointerup', to, 100, ms));
  };

  describe('opening', () => {
    it('opens on a slow drag in from the right edge, past the threshold', () => {
      // The band is 32–56px from the edge; 240 * 0.4 = 96px to commit.
      drag(OPENING_BAND_X, 240);

      expect(host.events).toEqual(['opened']);
    });

    it('ignores a drag that starts away from the edge', () => {
      // Otherwise every leftward swipe over the timeline would summon the roster.
      drag(200, 60);

      expect(host.events).toEqual([]);
    });

    it('snaps back when the drag stops short and was not a flick', () => {
      drag(OPENING_BAND_X, OPENING_BAND_X - 40, 800);

      expect(host.events).toEqual([]);
    });

    it('opens on a short FLICK that never reaches the threshold', () => {
      // Speed is a decision too. 40px in 50ms is 0.8px/ms, past the 0.5 commit velocity,
      // while being well under the 96px distance threshold.
      drag(OPENING_BAND_X, OPENING_BAND_X - 40, 50);

      expect(host.events).toEqual(['opened']);
    });

    it('reserves the extreme right edge for native history', () => {
      drag(400 - Math.floor(NATIVE_HISTORY_EDGE_PX / 2), 200);

      expect(host.events).toEqual([]);
    });

    it('opens from the inset band beside the native edge', () => {
      drag(OPENING_BAND_X, 200);

      expect(host.events).toEqual(['opened']);
    });
  });

  describe('closing', () => {
    beforeEach(() => {
      host.open.set(true);
      TestBed.tick();
    });

    it('closes on a drag away, from anywhere on the drawer', () => {
      // No edge zone when it is already open — the whole surface is grabbable.
      drag(100, 220);

      expect(host.events).toEqual(['closed']);
    });

    it('snaps back when the drag stops short', () => {
      drag(100, 140, 800);

      expect(host.events).toEqual([]);
    });
  });

  describe('what it refuses', () => {
    it('does nothing on a layout with no drawer', () => {
      // Above the `members` breakpoint the slot is a column, not an overlay.
      host.enabled.set(false);
      TestBed.tick();

      drag(OPENING_BAND_X, 240);

      expect(host.events).toEqual([]);
    });

    it('ignores a mouse, which has the button instead', () => {
      const down = new PointerEvent('pointerdown', {
        clientX: OPENING_BAND_X,
        pointerType: 'mouse',
        pointerId: 1,
        bubbles: true,
      });
      target.dispatchEvent(down);
      target.dispatchEvent(touch('pointermove', 280));
      target.dispatchEvent(touch('pointerup', 280));

      expect(host.events).toEqual([]);
    });

    it('abandons a gesture that turns into a vertical scroll', () => {
      // The drawer's own content scrolls; a finger that starts sideways and goes down is
      // reading, not dismissing.
      target.dispatchEvent(touch('pointerdown', OPENING_BAND_X, 100, 0));
      target.dispatchEvent(touch('pointermove', 280, 160, 200));
      target.dispatchEvent(touch('pointerup', 280, 160, 200));

      expect(host.events).toEqual([]);
    });
  });

  describe('one pointer, held for the whole gesture', () => {
    it('captures the pointer, so a release outside the host still arrives', () => {
      // Without capture a drag that leaves this element — sideways into the sidebar column,
      // which is a sibling between `md` and `members` — never gets its `pointerup`, and the
      // drawer is left translated mid-drag until the next press.
      const capture = vi.fn();
      target.setPointerCapture = capture;

      target.dispatchEvent(touch('pointerdown', OPENING_BAND_X, 100, 0));

      expect(capture).toHaveBeenCalledWith(1);
    });

    it('ignores a second finger landing mid-gesture', () => {
      target.dispatchEvent(touch('pointerdown', OPENING_BAND_X, 100, 0));
      target.dispatchEvent(touch('pointermove', OPENING_BAND_X - 60, 100, 100));
      expect(shell.style.getPropertyValue('--drawer-drag')).toBe('60px');

      // A different pointer id: another finger, not this swipe.
      const other = touch('pointermove', 200, 100, 120);
      Object.defineProperty(other, 'pointerId', { value: 2 });
      target.dispatchEvent(other);

      // Unmoved by it, and its release commits nothing.
      expect(shell.style.getPropertyValue('--drawer-drag')).toBe('60px');
      const otherUp = touch('pointerup', 200, 100, 130);
      Object.defineProperty(otherUp, 'pointerId', { value: 2 });
      target.dispatchEvent(otherUp);
      expect(host.events).toEqual([]);
    });
  });

  describe('what it writes while dragging', () => {
    it('moves one custom property, and commits nothing until release', () => {
      target.dispatchEvent(touch('pointerdown', OPENING_BAND_X, 100, 0));
      target.dispatchEvent(touch('pointermove', OPENING_BAND_X - 60, 100, 100));

      expect(shell.style.getPropertyValue('--drawer-drag')).toBe('60px');
      expect(host.events).toEqual([]);

      target.dispatchEvent(touch('pointerup', 240, 100, 200));

      // Handed back to CSS, so the drawer settles to its own position.
      expect(shell.style.getPropertyValue('--drawer-drag')).toBe('');
      expect(host.events).toEqual(['opened']);
    });

    it('clears the property when a gesture is abandoned', () => {
      target.dispatchEvent(touch('pointerdown', OPENING_BAND_X, 100, 0));
      target.dispatchEvent(touch('pointermove', OPENING_BAND_X - 60, 100, 100));
      target.dispatchEvent(touch('pointermove', 320, 200, 150)); // turned vertical

      expect(shell.style.getPropertyValue('--drawer-drag')).toBe('');
    });

    it('paints nothing when the user asked for less motion, but still commits', () => {
      // Someone who asked for less movement did not ask for a surface tracking their finger.
      // The gesture still works; it simply arrives without the drag following it.
      vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));

      target.dispatchEvent(touch('pointerdown', OPENING_BAND_X, 100, 0));
      target.dispatchEvent(touch('pointermove', 240, 100, 200));

      expect(shell.style.getPropertyValue('--drawer-drag')).toBe('');

      target.dispatchEvent(touch('pointerup', 240, 100, 200));
      expect(host.events).toEqual(['opened']);
    });
  });
});
