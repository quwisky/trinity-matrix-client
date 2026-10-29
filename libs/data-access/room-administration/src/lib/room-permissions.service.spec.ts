import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeRoomOptions } from '../contract/fake-room-administration-engine';
import { RoomActionPermissionError } from './room-action-permissions.service';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';
import {
  administrationSession,
  roomWithAlice,
} from './room-administration.spec-harness';
import { RoomPermissionsService } from './room-permissions.service';

const HIGHER = 'Only someone with a higher role can change this';

/** Alice at `alicePower` (null: no `users` entry) in bob's room; kick and ban need 50. */
async function setup({
  alicePower = 50,
  ...options
}: FakeRoomOptions & { alicePower?: number | null } = {}) {
  const session = administrationSession();
  const { engine } = session;
  const roomId = await roomWithAlice(engine, options);
  if (alicePower !== null) {
    await engine.asBob.setPowerLevel(roomId, engine.alice, alicePower);
  }
  TestBed.configureTestingModule({ providers: session.providers });
  const state = TestBed.inject(RoomAdministrationProjectionState);
  state.select(engine.alice, roomId);
  state.update('permissions', 'available', 'retained');
  return {
    ...session,
    roomId,
    key: { accountId: engine.alice, roomId },
    service: TestBed.inject(RoomPermissionsService),
    setState: vi.spyOn(engine, 'setState'),
  };
}

const row = (view: ReturnType<RoomPermissionsService['view']>, id: string) =>
  view.rows.find((r) => r.row.id === id)!;

afterEach(() => TestBed.resetTestingModule());

describe('RoomPermissionsService', () => {
  it('view rows are editable up to my power', async () => {
    const { service, key, engine, roomId } = await setup();
    await engine.asBob.setPowerLevels(roomId, { ban: 100 });

    const view = service.view(key, 'room');

    expect(row(view, 'kick')).toMatchObject({ editable: true, reason: null });
    expect(row(view, 'ban')).toMatchObject({ editable: false, reason: HIGHER });
  });

  it('a v12 creator has no cap', async () => {
    const { service, key } = await setup({
      roomVersion: '12',
      additionalCreators: ['@alice:example.org'],
      alicePower: null,
    });

    const view = service.view(key, 'room');

    expect(view.myPower).toBe(Infinity);
    expect(view.rows.every((r) => r.editable)).toBe(true);
    expect(view.powerFromDefault).toBe(false);
  });

  it('read-only without permission to send power levels', async () => {
    const { service, key, engine, roomId } = await setup();
    await engine.asBob.setPowerLevels(roomId, {
      events: { 'm.room.power_levels': 100 },
    });

    const view = service.view(key, 'room');

    expect(view.editable).toBe(false);
    expect(view.reason).toBe(
      "Your role cannot change this room's permissions.",
    );
    expect(view.rows.some((r) => r.editable)).toBe(false);
    expect(service.view(key, 'space').reason).toBe(
      "Your role cannot change this space's permissions.",
    );
  });

  it('read-only when the room has no power-levels event', async () => {
    const { service, key, setState } = await setup({
      withoutPowerLevels: true,
      alicePower: null,
    });

    expect(service.view(key, 'room')).toMatchObject({
      editable: false,
      reason: 'This room has no permission settings to edit.',
    });
    await expect(
      firstValueFrom(service.save(key, 'room', new Map([['kick', 0]]))),
    ).rejects.toBeInstanceOf(RoomActionPermissionError);
    expect(setState).not.toHaveBeenCalled();
  });

  it('powerFromDefault is true when users lacks me and false when present', async () => {
    const { service, key, engine, roomId } = await setup({ alicePower: null });

    expect(service.view(key, 'room').powerFromDefault).toBe(true);
    await engine.asBob.setPowerLevel(roomId, engine.alice, 0);
    expect(service.view(key, 'room').powerFromDefault).toBe(false);
  });

  it('save writes only changed rows onto the live event, keeping unknown keys', async () => {
    const { service, key, engine, roomId, setState } = await setup();
    service.view(key, 'room');
    await engine.asBob.setPowerLevels(roomId, {
      ban: 80,
      'org.example.custom': { kept: [1] },
    });
    await engine.asBob.setPowerLevel(roomId, '@b:example.org', 100);

    await firstValueFrom(
      service.save(key, 'room', new Map([['send-messages', 50]])),
    );

    expect(setState).toHaveBeenCalledWith(
      engine.alice,
      roomId,
      'm.room.power_levels',
      '',
      expect.objectContaining({
        ban: 80,
        events_default: 50,
        'org.example.custom': { kept: [1] },
        users: {
          [engine.bob]: 100,
          [engine.alice]: 50,
          '@b:example.org': 100,
        },
      }),
    );
  });

  it('save refuses a row that became higher than me', async () => {
    const { service, key, engine, roomId, setState } = await setup();
    await engine.asBob.setPowerLevels(roomId, { kick: 100 });

    await expect(
      firstValueFrom(service.save(key, 'room', new Map([['kick', 0]]))),
    ).rejects.toMatchObject({ message: HIGHER });
    expect(setState).not.toHaveBeenCalled();
  });

  it.each([60, 1.5, Number.MAX_SAFE_INTEGER + 2])(
    'save refuses level %s',
    async (level) => {
      const { service, key, setState } = await setup();

      await expect(
        firstValueFrom(service.save(key, 'room', new Map([['kick', level]]))),
      ).rejects.toBeInstanceOf(RoomActionPermissionError);
      expect(setState).not.toHaveBeenCalled();
    },
  );

  it('saves as the given account, not the active one', async () => {
    const { service, engine, roomId, signIn, setState } = await setup();
    engine.setLive(engine.bob, true);
    signIn([engine.alice, engine.bob], { active: engine.alice });

    await firstValueFrom(
      service.save(
        { accountId: engine.bob, roomId },
        'room',
        new Map([['kick', 10]]),
      ),
    );

    expect(setState).toHaveBeenCalledOnce();
    expect(setState.mock.calls[0][0]).toBe(engine.bob);
  });

  it('refuses to save without a live account', async () => {
    const { service, key, signIn, setState } = await setup();
    signIn([]);

    await expect(
      firstValueFrom(service.save(key, 'room', new Map([['kick', 10]]))),
    ).rejects.toThrow(/not signed in/i);
    expect(setState).not.toHaveBeenCalled();
  });
});
