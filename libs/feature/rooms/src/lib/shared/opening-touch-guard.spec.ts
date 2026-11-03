import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardOpeningTouch } from './opening-touch-guard';

// jsdom's CSSOM drops these properties, so what the guard writes is read from the calls.
const written = () => {
  const style = document.body.style;
  const set = vi
    .mocked(style.setProperty)
    .mock.calls.map(([name, value]) => `${name}:${value}`);
  const removed = vi
    .mocked(style.removeProperty)
    .mock.calls.map(([name]) => name);
  return { set, removed };
};
/** A touch event with `left` fingers still down; jsdom has no `Touch` to build a real list from. */
const touchEnd = (type: 'touchend' | 'touchcancel', left = 0) =>
  document.dispatchEvent(
    Object.assign(new Event(type), { touches: { length: left } }),
  );
const lift = (pointerId: number) =>
  document.dispatchEvent(new PointerEvent('pointerup', { pointerId }));
/** Whether an event of `type` survives the capture-phase guard: false while it is swallowed. */
const reaches = (type: string) => {
  const seen = vi.fn();
  document.body.addEventListener(type, seen);
  const event = new Event(type, { bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  document.body.removeEventListener(type, seen);
  return seen.mock.calls.length === 1 && !event.defaultPrevented;
};

describe('guardOpeningTouch', () => {
  beforeEach(() => {
    vi.spyOn(document.body.style, 'setProperty');
    vi.spyOn(document.body.style, 'removeProperty');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.replaceChildren();
    document.getSelection()?.removeAllRanges();
  });

  it('stops selection, the callout and the click while the opening finger is down', () => {
    const release = guardOpeningTouch(1);
    expect(written().set).toEqual([
      'user-select:none',
      '-webkit-user-select:none',
      '-webkit-touch-callout:none',
    ]);
    expect(written().removed).toEqual([]);
    expect(reaches('selectstart')).toBe(false);
    expect(reaches('contextmenu')).toBe(false);
    release();
  });

  it('hands selection back after the lift and clears what the hold selected', () => {
    vi.useFakeTimers();
    const text = document.createElement('p');
    text.textContent = 'Reply in thread';
    document.body.append(text);
    guardOpeningTouch(1);
    // What WebKit's long press would have made under the finger.
    document.getSelection()!.selectAllChildren(text);

    lift(1);
    vi.advanceTimersByTime(300);

    expect(document.getSelection()!.toString()).toBe('');
    expect(written().removed).toEqual([
      'user-select',
      '-webkit-user-select',
      '-webkit-touch-callout',
    ]);
    expect(reaches('selectstart')).toBe(true);
    expect(reaches('contextmenu')).toBe(true);
  });

  it('keeps a selection that was there before the hold, and a caret', () => {
    const text = document.createElement('p');
    text.textContent = 'earlier';
    document.body.append(text);
    document.getSelection()!.selectAllChildren(text);
    guardOpeningTouch(1)();
    expect(document.getSelection()!.toString()).toBe('earlier');

    document.getSelection()!.collapse(text.firstChild, 2);
    guardOpeningTouch(2)();
    expect(document.getSelection()!.rangeCount).toBe(1);
  });

  it('swallows the one click that follows the lift', () => {
    vi.useFakeTimers();
    guardOpeningTouch(1);
    lift(1);
    expect(reaches('click')).toBe(false);
    expect(reaches('click')).toBe(true);
  });

  it('ignores the lift of another pointer, and releases when one goes down', () => {
    vi.useFakeTimers();
    guardOpeningTouch(1);
    lift(2);
    vi.advanceTimersByTime(400);
    expect(reaches('selectstart')).toBe(false);

    document.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2 }));
    expect(reaches('selectstart')).toBe(true);
  });

  it('holds on through a pointercancel, the finger still down, until the touch ends', () => {
    vi.useFakeTimers();
    guardOpeningTouch(1);
    document.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
    vi.advanceTimersByTime(400);
    expect(reaches('selectstart')).toBe(false);

    touchEnd('touchend');
    vi.advanceTimersByTime(299);
    expect(reaches('selectstart')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(reaches('selectstart')).toBe(true);
  });

  it('ends on a touchcancel once no finger is left', () => {
    vi.useFakeTimers();
    guardOpeningTouch(1);
    touchEnd('touchend', 1);
    vi.advanceTimersByTime(400);
    expect(reaches('selectstart')).toBe(false);

    touchEnd('touchcancel');
    vi.advanceTimersByTime(300);
    expect(reaches('selectstart')).toBe(true);
  });

  it('clears what the hold selected even over an earlier selection', () => {
    const earlier = document.createElement('p');
    earlier.textContent = 'earlier';
    const sheet = document.createElement('p');
    sheet.textContent = 'Reply in thread';
    document.body.append(earlier, sheet);
    document.getSelection()!.selectAllChildren(earlier);

    const release = guardOpeningTouch(1);
    document.getSelection()!.selectAllChildren(sheet);
    release();

    expect(document.getSelection()!.toString()).toBe('');
  });

  it('releases after the fallback when no end ever arrives', () => {
    vi.useFakeTimers();
    guardOpeningTouch(1);
    vi.advanceTimersByTime(9_999);
    expect(reaches('selectstart')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(reaches('selectstart')).toBe(true);
  });
});
