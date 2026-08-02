import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MruRoomsService } from './mru-rooms.service';

const ALL = new Set(['!a', '!b', '!c']);

describe('MruRoomsService', () => {
  let svc: MruRoomsService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [MruRoomsService] });
    svc = TestBed.inject(MruRoomsService);
  });

  /** Visit a, then b, then c → stack is [c, b, a]. */
  function seedABC(): void {
    svc.record('!a');
    svc.record('!b');
    svc.record('!c');
  }

  describe('record', () => {
    it('moves the visited room to the front, deduped', () => {
      seedABC();
      expect(svc.visited()).toEqual(['!c', '!b', '!a']);

      svc.record('!a'); // re-visiting an existing room floats it, no duplicate
      expect(svc.visited()).toEqual(['!a', '!c', '!b']);
    });

    it('caps the stack', () => {
      for (let i = 0; i < 30; i++) {
        svc.record(`!r${i}`);
      }
      expect(svc.visited().length).toBe(20);
      expect(svc.visited()[0]).toBe('!r29'); // newest kept
    });
  });

  describe('hop', () => {
    it('cycles deeper on repeated presses, then clamps at the end', () => {
      seedABC(); // [c, b, a], currently in c
      expect(svc.hop('back', '!c', ALL)).toBe('!b'); // previous
      expect(svc.hop('back', '!b', ALL)).toBe('!a'); // two back
      expect(svc.hop('back', '!a', ALL)).toBe('!a'); // clamps — no fourth room
    });

    it('does not reorder the stack while cycling', () => {
      seedABC();
      svc.hop('back', '!c', ALL);
      svc.hop('back', '!b', ALL);
      // The frozen order is what makes cycle-deeper work; commit happens later.
      expect(svc.visited()).toEqual(['!c', '!b', '!a']);
    });

    it('steps forward with Shift, clamping at the start', () => {
      seedABC();
      svc.hop('back', '!c', ALL); // → b
      svc.hop('back', '!b', ALL); // → a
      expect(svc.hop('forward', '!a', ALL)).toBe('!b'); // step back toward the start
      expect(svc.hop('forward', '!b', ALL)).toBe('!c'); // the room we started in
      expect(svc.hop('forward', '!c', ALL)).toBe('!c'); // clamps
    });

    it('skips a room that no longer exists', () => {
      seedABC(); // [c, b, a]
      // b has been left/forgotten — hopping from c goes straight to a.
      expect(svc.hop('back', '!c', new Set(['!a', '!c']))).toBe('!a');
    });

    it('returns null when there is nowhere to hop', () => {
      svc.record('!a'); // only room, and we're in it
      expect(svc.hop('back', '!a', ALL)).toBeNull();
      expect(svc.hopping).toBe(false);
    });
  });

  describe('idle commit', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('promotes the landed room to the front once hopping pauses', () => {
      seedABC();
      svc.hop('back', '!c', ALL); // → b
      svc.hop('back', '!b', ALL); // → a
      expect(svc.hopping).toBe(true);

      vi.advanceTimersByTime(1200);

      expect(svc.hopping).toBe(false);
      expect(svc.visited()).toEqual(['!a', '!c', '!b']); // a landed → front
    });

    it('re-arms on each press so a mid-cycle press does not commit early', () => {
      seedABC();
      svc.hop('back', '!c', ALL);
      vi.advanceTimersByTime(1000);
      svc.hop('back', '!b', ALL); // resets the idle timer
      vi.advanceTimersByTime(1000);
      expect(svc.hopping).toBe(true); // 2s elapsed but never 1.2s idle
    });
  });

  it('ends the hop session when a room is opened another way', () => {
    seedABC();
    svc.hop('back', '!c', ALL);
    expect(svc.hopping).toBe(true);

    svc.record('!a'); // an explicit open commits and clears the cycle
    expect(svc.hopping).toBe(false);
    expect(svc.visited()).toEqual(['!a', '!c', '!b']);
  });

  describe('nth', () => {
    it('resolves the Nth most-recent room, skipping the current one', () => {
      seedABC(); // [c, b, a], in c
      expect(svc.nth(1, '!c')).toBe('!b'); // 1 = previous
      expect(svc.nth(2, '!c')).toBe('!a');
      expect(svc.nth(3, '!c')).toBeNull(); // nothing that deep
    });
  });
});
