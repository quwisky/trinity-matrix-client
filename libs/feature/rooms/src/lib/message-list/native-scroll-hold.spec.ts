import { describe, expect, it } from 'vitest';
import { NativeScrollHold } from './native-scroll-hold';

describe('NativeScrollHold', () => {
  it('never claims the scroll view owns the position off iOS', () => {
    const hold = new NativeScrollHold(false);
    hold.touched(1);

    expect(hold.ownedByScrollView(true)).toBe(false);
  });

  it('holds during a touch, and through momentum once the finger has lifted', () => {
    const hold = new NativeScrollHold(true);
    expect(hold.ownedByScrollView(false)).toBe(false);

    hold.touched(1);
    expect(hold.ownedByScrollView(false)).toBe(true);

    hold.touched(0);
    expect(hold.ownedByScrollView(true)).toBe(true);
    expect(hold.ownedByScrollView(false)).toBe(false);
  });

  it('keeps holding while any finger remains', () => {
    const hold = new NativeScrollHold(true);
    hold.shift.set(500);
    hold.touched(2);
    hold.touched(1);

    expect(hold.ownedByScrollView(false)).toBe(true);
    expect(hold.canSettle()).toBe(false);
  });

  it('settles what it holds, once', () => {
    const hold = new NativeScrollHold(true);
    expect(hold.canSettle()).toBe(false);

    hold.shift.set(500);
    expect(hold.canSettle()).toBe(true);
    expect(hold.settle()).toBe(500);

    expect(hold.shift()).toBe(0);
    expect(hold.canSettle()).toBe(false);
  });

  it('holds again when the scroll view puts the old position back', () => {
    const hold = new NativeScrollHold(true);
    hold.wrote(100, 600, 0);

    expect(hold.scrolled(600, 16)).toBe(false); // the write's own event, a few frames ahead of the undo
    expect(hold.scrolled(102, 16)).toBe(true);

    expect(hold.shift()).toBe(498);
  });

  it('waits for the reader to move before trying again after a refusal', () => {
    // A finger holding a caught fling produces no events, so each retry would flash the wrong
    // rows for a few frames with nothing to show for it.
    const hold = new NativeScrollHold(true);
    hold.wrote(100, 600, 0);
    hold.scrolled(100, 16);
    expect(hold.canSettle()).toBe(false);

    hold.scrolled(90, 16);

    expect(hold.canSettle()).toBe(true);
  });

  it('takes a real touch as a reason to try again', () => {
    const hold = new NativeScrollHold(true);
    hold.wrote(100, 600, 0);
    hold.scrolled(100, 16);

    hold.touched(1);
    hold.touched(0);

    expect(hold.canSettle()).toBe(true);
  });

  it('leaves a write alone when the reader simply scrolls on from it', () => {
    const hold = new NativeScrollHold(true);
    hold.wrote(100, 600, 0);

    expect(hold.scrolled(597, 16)).toBe(false);
    // Past that first move, reaching the old position is the reader's own doing.
    expect(hold.scrolled(100, 16)).toBe(false);
    expect(hold.shift()).toBe(0);
  });

  it('does not read a small write as undone: the reader may simply have moved', () => {
    const hold = new NativeScrollHold(true);
    hold.wrote(100, 110, 0);

    expect(hold.scrolled(100, 16)).toBe(false);
    expect(hold.shift()).toBe(0);
  });

  it('watches nothing off iOS', () => {
    const hold = new NativeScrollHold(false);
    hold.wrote(100, 600, 0);

    expect(hold.scrolled(100, 16)).toBe(false);
    expect(hold.shift()).toBe(0);
  });

  it('stops watching a write after a few frames: the old position is then the list going there', () => {
    const hold = new NativeScrollHold(true);
    hold.wrote(5, 1205, 0);
    expect(hold.scrolled(1205, 16)).toBe(false);

    expect(hold.scrolled(0, 301)).toBe(false);

    expect(hold.shift()).toBe(0);
  });

  it('stops watching a write once told to', () => {
    const hold = new NativeScrollHold(true);
    hold.wrote(5, 1205, 0);

    hold.forgetWrite();

    expect(hold.scrolled(0, 16)).toBe(false);
    expect(hold.shift()).toBe(0);
  });

  it('forgets a held shift and any touch on reset', () => {
    const hold = new NativeScrollHold(true);
    hold.touched(1);
    hold.shift.set(500);

    hold.reset();

    expect(hold.shift()).toBe(0);
    expect(hold.ownedByScrollView(false)).toBe(false);
  });
});
