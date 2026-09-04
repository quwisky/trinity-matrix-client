import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MruRoomsService } from './mru-rooms.service';

const A = { accountId: '@me:hs', roomId: '!a' } as const;
const B = { accountId: '@me:hs', roomId: '!b' } as const;
const C = { accountId: '@me:hs', roomId: '!c' } as const;
const ALL = [A, B, C];

describe('MruRoomsService', () => {
  let svc: MruRoomsService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [MruRoomsService] });
    svc = TestBed.inject(MruRoomsService);
  });

  /** Visit a, then b, then c → stack is [c, b, a]. */
  function seedABC(): void {
    svc.record(A);
    svc.record(B);
    svc.record(C);
  }

  describe('record', () => {
    it('moves the visited room to the front, deduped', () => {
      seedABC();
      expect(svc.visited()).toEqual([C, B, A]);

      svc.record(A); // re-visiting an existing room floats it, no duplicate
      expect(svc.visited()).toEqual([A, C, B]);
    });

    it('caps the stack', () => {
      for (let i = 0; i < 30; i++) {
        svc.record({ accountId: '@me:hs', roomId: `!r${i}` });
      }
      expect(svc.visited().length).toBe(20);
      expect(svc.visited()[0]).toEqual({
        accountId: '@me:hs',
        roomId: '!r29',
      });
    });

    it('keeps the same room id distinct across accounts', () => {
      const other = { accountId: '@other:hs', roomId: A.roomId };
      svc.record(A);
      svc.record(other);

      expect(svc.visited()).toEqual([other, A]);
    });
  });

  describe('hop', () => {
    it('cycles deeper on repeated presses, then clamps at the end', () => {
      seedABC(); // [c, b, a], currently in c
      expect(svc.hop('back', C, ALL)).toEqual(B); // previous
      expect(svc.hop('back', B, ALL)).toEqual(A); // two back
      expect(svc.hop('back', A, ALL)).toEqual(A); // clamps — no fourth room
    });

    it('does not reorder the stack while cycling', () => {
      seedABC();
      svc.hop('back', C, ALL);
      svc.hop('back', B, ALL);
      // The frozen order is what makes cycle-deeper work; commit happens later.
      expect(svc.visited()).toEqual([C, B, A]);
    });

    it('steps forward with Shift, clamping at the start', () => {
      seedABC();
      svc.hop('back', C, ALL); // → b
      svc.hop('back', B, ALL); // → a
      expect(svc.hop('forward', A, ALL)).toEqual(B); // step toward start
      expect(svc.hop('forward', B, ALL)).toEqual(C); // starting room
      expect(svc.hop('forward', C, ALL)).toEqual(C); // clamps
    });

    it('skips a room that no longer exists', () => {
      seedABC(); // [c, b, a]
      // b has been left/forgotten — hopping from c goes straight to a.
      expect(svc.hop('back', C, [A, C])).toEqual(A);
    });

    it('returns null when there is nowhere to hop', () => {
      svc.record(A); // only room, and we're in it
      expect(svc.hop('back', A, ALL)).toBeNull();
      expect(svc.hopping).toBe(false);
    });
  });

  describe('idle commit', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('promotes the landed room to the front once hopping pauses', () => {
      seedABC();
      svc.hop('back', C, ALL); // → b
      svc.hop('back', B, ALL); // → a
      expect(svc.hopping).toBe(true);

      vi.advanceTimersByTime(1200);

      expect(svc.hopping).toBe(false);
      expect(svc.visited()).toEqual([A, C, B]); // a landed → front
    });

    it('re-arms on each press so a mid-cycle press does not commit early', () => {
      seedABC();
      svc.hop('back', C, ALL);
      vi.advanceTimersByTime(1000);
      svc.hop('back', B, ALL); // resets the idle timer
      vi.advanceTimersByTime(1000);
      expect(svc.hopping).toBe(true); // 2s elapsed but never 1.2s idle
    });
  });

  it('ends the hop session when a room is opened another way', () => {
    seedABC();
    svc.hop('back', C, ALL);
    expect(svc.hopping).toBe(true);

    svc.record(A); // an explicit open commits and clears the cycle
    expect(svc.hopping).toBe(false);
    expect(svc.visited()).toEqual([A, C, B]);
  });

  describe('nth', () => {
    it('resolves the Nth most-recent room, skipping the current one', () => {
      seedABC(); // [c, b, a], in c
      expect(svc.nth(1, C)).toEqual(B); // 1 = previous
      expect(svc.nth(2, C)).toEqual(A);
      expect(svc.nth(3, C)).toBeNull(); // nothing that deep
    });
  });
});
