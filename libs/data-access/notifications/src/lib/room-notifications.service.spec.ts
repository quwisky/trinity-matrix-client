import { TestBed } from '@angular/core/testing';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { EngineRequestError, engineFail } from '@trinity/util/matrix';
import { setupLiveNotificationSettings } from '../contract/live-notification-settings';
import { RoomNotificationsService } from './room-notifications.service';

const ROOM = '!room:fake';
const ALICE = '@alice:fake'; // the fake engine's one account with settings
const BOB = '@bob:fake';

function setup(options: { active?: string | null; live?: string[] } = {}) {
  const { engine, alice } = setupLiveNotificationSettings(options);
  return {
    svc: TestBed.inject(RoomNotificationsService),
    engine,
    alice,
    setRoomMode: vi.spyOn(engine, 'setRoomMode'),
  };
}

const roomMatch = (roomId: string) => [
  { kind: 'event_match', key: 'room_id', pattern: roomId },
];

describe('RoomNotificationsService', () => {
  describe('modeFor', () => {
    it('reports "all" with no room rules, and before sign-in', () => {
      expect(setup().svc.modeFor(ROOM)).toBe('all');
      TestBed.resetTestingModule();
      expect(setup({ active: null }).svc.modeFor(ROOM)).toBe('all');
    });

    it('reads the active account’s mode and follows another client’s change', () => {
      const { svc, engine } = setup();
      engine.writeRoomRule('room', ROOM, { actions: [] });
      expect(svc.modeFor(ROOM)).toBe('mentions');

      engine.writeRoomRule('override', ROOM, {
        actions: [],
        conditions: roomMatch(ROOM),
      });
      expect(svc.modeFor(ROOM)).toBe('mute');
    });

    it('reads the owning account, not the active one', () => {
      const { svc, engine, alice } = setup({
        active: BOB,
        live: [ALICE, BOB],
      });
      engine.writeRoomRule('room', ROOM, { actions: [] });

      expect(svc.modeFor(ROOM)).toBe('all');
      expect(svc.modeFor(ROOM, alice)).toBe('mentions');
    });

    it('reports a mixed mode when merged accounts disagree', () => {
      const { svc, engine, alice } = setup({ live: [ALICE, BOB] });
      engine.writeRoomRule('room', ROOM, { actions: [] });

      expect(svc.modeForAccounts(ROOM, [alice, BOB])).toBe('mixed');
      expect(svc.modeForAccounts(ROOM, [alice, alice])).toBe('mentions');
      expect(svc.modeForAccounts(ROOM)).toBe('mentions');
    });
  });

  describe('setMode', () => {
    it('writes the mode to the active account, cold', async () => {
      const { svc, alice, setRoomMode } = setup();
      const write = svc.setMode(ROOM, 'mute');
      expect(setRoomMode).not.toHaveBeenCalled();

      await firstValueFrom(write);

      expect(setRoomMode).toHaveBeenCalledWith(alice, ROOM, 'mute');
      expect(svc.modeFor(ROOM)).toBe('mute');
    });

    it('replaces another client’s custom rules for the room', async () => {
      const { svc, engine } = setup();
      engine.writeRoomRule('override', 'custom', {
        actions: ['notify'],
        conditions: roomMatch(ROOM),
      });

      await firstValueFrom(svc.setMode(ROOM, 'mentions'));

      expect(engine.serverRoomRules(ROOM)).toEqual([
        { kind: 'room', ruleId: ROOM, enabled: true, actions: [] },
      ]);
    });

    it('writes the owning account, not the active one', async () => {
      const { svc, alice, setRoomMode } = setup({
        active: BOB,
        live: [ALICE, BOB],
      });

      await firstValueFrom(svc.setMode(ROOM, 'mute', alice));

      expect(setRoomMode).toHaveBeenCalledOnce();
      expect(setRoomMode).toHaveBeenCalledWith(alice, ROOM, 'mute');
      expect(svc.modeFor(ROOM, alice)).toBe('mute');
    });

    it('fails before sign-in without writing', async () => {
      const { svc, setRoomMode } = setup({ active: null });

      await expect(firstValueFrom(svc.setMode(ROOM, 'mute'))).rejects.toThrow(
        'Not signed in.',
      );
      expect(setRoomMode).not.toHaveBeenCalled();
    });

    it('writes every merged account and reports a failed one, keeping the others', async () => {
      const { svc, alice, setRoomMode } = setup({ live: [ALICE, BOB] });

      const error = await firstValueFrom(
        svc.setModeForAccounts(ROOM, 'mute', [alice, BOB]),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(EngineRequestError);
      expect((error as EngineRequestError).failure.code).toBe(
        'account-not-live',
      );
      expect(setRoomMode).toHaveBeenCalledTimes(2);
      expect(svc.modeFor(ROOM, alice)).toBe('mute');
    });

    it('reports a refused write as an EngineRequestError', async () => {
      const { svc, setRoomMode } = setup();
      setRoomMode.mockReturnValue(
        of(
          engineFail({
            kind: 'http',
            code: 'request-failed',
            diagnostic: { kind: 'http', httpStatus: 500 },
          }),
        ),
      );

      await expect(firstValueFrom(svc.setMode(ROOM, 'mute'))).rejects.toThrow(
        EngineRequestError,
      );
      expect(svc.modeFor(ROOM)).toBe('all');
    });
  });

  describe('readMode', () => {
    it('reads the exact account’s mode from the engine', async () => {
      const { svc, engine, alice } = setup({ active: BOB, live: [ALICE, BOB] });
      engine.writeRoomRule('room', ROOM, { actions: [] });

      await expect(firstValueFrom(svc.readMode(ROOM, alice))).resolves.toBe(
        'mentions',
      );
    });

    it('fails for an account that is not live instead of guessing a default', async () => {
      const { svc } = setup();

      await expect(
        firstValueFrom(svc.readMode(ROOM, BOB)),
      ).rejects.toBeInstanceOf(EngineRequestError);
    });
  });

  describe('projection', () => {
    it('acknowledges notifications.room-rules on its first reconcile and retries without release', async () => {
      const { svc } = setup();
      const conditions: string[] = [];
      TestBed.inject(ProjectionRuntime)
        .observe('notifications.room-rules', { kind: 'active-account' })
        .subscribe((state) => conditions.push(state.condition));

      const lifetime = svc.runProjection().subscribe();
      expect(conditions.at(-1)).toBe('available');
      const connected = conditions.length;

      svc.retryProjection();
      await Promise.resolve();

      expect(conditions.at(-1)).toBe('available');
      expect(conditions.slice(connected)).not.toContain('released');
      lifetime.unsubscribe();
      expect(conditions.at(-1)).toBe('released');
    });
  });
});
