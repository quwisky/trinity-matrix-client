import { TestBed } from '@angular/core/testing';
import { DOCUMENT } from '@angular/common';
import {
  PointerPressService,
  PRESS_WATCHDOG_MS,
} from './pointer-press.service';

describe('PointerPressService', () => {
  let press: PointerPressService;
  let doc: Document;
  const fire = (type: string, target: EventTarget = doc) =>
    target.dispatchEvent(new Event(type, { bubbles: true }));
  /** A pointer event for one pointer; jsdom has no PointerEvent constructor. */
  const firePointer = (type: string, pointerId: number) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    doc.dispatchEvent(event);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    press = TestBed.inject(PointerPressService);
    doc = TestBed.inject(DOCUMENT);
  });
  afterEach(() => vi.useRealTimers());

  it('is pressed from pointerdown until pointerup', () => {
    expect(press.pressed()).toBe(false);
    fire('pointerdown');
    expect(press.pressed()).toBe(true);
    fire('pointerup');
    expect(press.pressed()).toBe(false);
  });

  it.each(['pointercancel', 'lostpointercapture'])('releases on %s', (type) => {
    fire('pointerdown');
    fire(type);
    expect(press.pressed()).toBe(false);
  });

  it('releases when the window loses focus or the page is hidden', () => {
    fire('pointerdown');
    fire('blur', doc.defaultView!);
    expect(press.pressed()).toBe(false);
    fire('pointerdown');
    fire('visibilitychange');
    expect(press.pressed()).toBe(false);
  });

  it('never stays pressed past the watchdog', () => {
    fire('pointerdown');
    vi.advanceTimersByTime(PRESS_WATCHDOG_MS);
    expect(press.pressed()).toBe(false);
  });

  describe('with several pointers', () => {
    it('stays pressed until the last pointer is lifted', () => {
      firePointer('pointerdown', 1);
      firePointer('pointerdown', 2);
      firePointer('pointerup', 1);
      expect(press.pressed()).toBe(true);
      firePointer('pointerup', 2);
      expect(press.pressed()).toBe(false);
    });

    it.each(['pointercancel', 'lostpointercapture'])(
      'releases only the pointer that ends with %s',
      (type) => {
        firePointer('pointerdown', 1);
        firePointer('pointerdown', 2);
        firePointer(type, 2);
        expect(press.pressed()).toBe(true);
        firePointer(type, 1);
        expect(press.pressed()).toBe(false);
      },
    );

    it('releases every pointer on blur, a hidden page or the watchdog', () => {
      firePointer('pointerdown', 1);
      firePointer('pointerdown', 2);
      fire('blur', doc.defaultView!);
      expect(press.pressed()).toBe(false);
      // Nothing is left over: one new press and its release end the latch.
      firePointer('pointerdown', 3);
      firePointer('pointerup', 3);
      expect(press.pressed()).toBe(false);

      firePointer('pointerdown', 1);
      firePointer('pointerdown', 2);
      fire('visibilitychange');
      expect(press.pressed()).toBe(false);

      firePointer('pointerdown', 1);
      firePointer('pointerdown', 2);
      vi.advanceTimersByTime(PRESS_WATCHDOG_MS);
      expect(press.pressed()).toBe(false);
      firePointer('pointerdown', 3);
      firePointer('pointerup', 3);
      expect(press.pressed()).toBe(false);
    });
  });
});
