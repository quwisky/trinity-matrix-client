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
});
