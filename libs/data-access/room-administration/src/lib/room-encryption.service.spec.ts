import { TestBed } from '@angular/core/testing';
import { type EngineFailure, engineFail } from '@trinity/util/matrix';
import { Subject, firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeRoomOptions } from '../contract/fake-room-administration-engine';
import { AdministeredRoomStore } from './administered-room.store';
import { RoomActionPermissionError } from './room-action-permissions.service';
import { RoomAdministrationError } from './room-administration-error';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';
import {
  administrationSession,
  roomWithAlice,
} from './room-administration.spec-harness';
import { RoomEncryptionService } from './room-encryption.service';
import type { EngineResult } from '@trinity/util/matrix';

/** Bob's room with alice at `alicePower` (100 may turn encryption on). */
async function setup({
  alicePower = 100,
  ...options
}: FakeRoomOptions & { alicePower?: number } = {}) {
  const session = administrationSession();
  const { engine } = session;
  const roomId = await roomWithAlice(engine, options);
  await engine.asBob.setPowerLevel(roomId, engine.alice, alicePower);
  TestBed.configureTestingModule({ providers: session.providers });
  const state = TestBed.inject(RoomAdministrationProjectionState);
  state.select(engine.alice, roomId);
  state.update('permissions', 'available', 'retained');
  const target = { accountId: engine.alice, roomId };
  return {
    ...session,
    target,
    enable: vi.spyOn(engine, 'enableEncryption'),
    room: () =>
      TestBed.inject(AdministeredRoomStore).room(engine.alice, roomId),
    svc: TestBed.inject(RoomEncryptionService),
  };
}

const failure = (action: Promise<unknown>) =>
  action.then(
    () => null,
    (error: unknown) => error,
  );

const failed = (code: string, extra: Partial<EngineFailure> = {}) =>
  of(
    engineFail({
      kind: 'unexpected',
      code,
      diagnostic: { kind: 'unexpected' },
      ...extra,
    } as EngineFailure),
  );

afterEach(() => TestBed.resetTestingModule());

describe('RoomEncryptionService', () => {
  it('is cold, then turns encryption on as the opening account', async () => {
    const { svc, target, enable, room } = await setup();

    const action = svc.turnOn(target);
    expect(enable).not.toHaveBeenCalled();

    await firstValueFrom(action, { defaultValue: undefined });
    expect(enable).toHaveBeenCalledExactlyOnceWith(
      target.accountId,
      target.roomId,
    );
    expect(room()?.state.encryption).toEqual({
      algorithm: 'm.megolm.v1.aes-sha2',
    });
  });

  it('adopts the event the server has when sync missed it', async () => {
    const { svc, target, engine, room } = await setup({ encrypted: true });
    engine.withholdFromSnapshot(target.roomId, 'm.room.encryption');
    expect(room()?.encryption).toBe('unencrypted');

    await firstValueFrom(svc.turnOn(target), { defaultValue: undefined });

    expect(room()?.encryption).toBe('encrypted');
    const events = await firstValueFrom(
      engine.stateEvents(target.accountId, target.roomId),
    );
    const encryption = events.ok
      ? events.value.find(({ type }) => type === 'm.room.encryption')
      : undefined;
    expect(encryption?.event).toMatchObject({ sender: engine.bob });
  });

  it('refuses a room the room state or the crypto store has encrypted, without asking the engine', async () => {
    for (const options of [
      { encrypted: true },
      { encryptionUnknown: true },
    ] as const) {
      TestBed.resetTestingModule();
      const { svc, target, enable, engine } = await setup(options);
      if (options.encryptionUnknown) {
        engine.answerEncryption(target.roomId, true);
      }

      const error = await failure(firstValueFrom(svc.turnOn(target)));

      expect((error as RoomAdministrationError).outcome.failure).toBe(
        'invalid-input',
      );
      expect((error as Error).message).toBe('This room is already encrypted.');
      expect(enable).not.toHaveBeenCalled();
    }
  });

  it.each([
    [
      'already-encrypted',
      { failure: 'invalid-input' },
      'This room is already encrypted.',
    ],
    [
      'encryption-not-applied',
      { failure: 'partial-update', recovery: 'review-room-state' },
      "Encryption is on, but this device couldn't apply it.",
    ],
    ['account-not-live', { failure: 'not-signed-in' }, 'Not signed in.'],
    ['room-unavailable', { failure: 'not-signed-in' }, 'Not signed in.'],
  ])('maps the engine failure %s', async (code, outcome, message) => {
    const { svc, target, enable } = await setup();
    enable.mockReturnValue(failed(code));

    const error = await failure(firstValueFrom(svc.turnOn(target)));

    expect(error).toBeInstanceOf(RoomAdministrationError);
    expect((error as RoomAdministrationError).outcome).toMatchObject({
      ...outcome,
      operation: 'turn-on-encryption',
    });
    expect((error as Error).message).toBe(message);
  });

  it('reports a server rejection as a retryable typed error', async () => {
    const { svc, target, enable } = await setup();
    enable.mockReturnValue(
      failed('request-failed', {
        kind: 'permission',
        diagnostic: { kind: 'permission', httpStatus: 403 },
      }),
    );

    const error = await failure(firstValueFrom(svc.turnOn(target)));

    expect((error as RoomAdministrationError).outcome).toMatchObject({
      failure: 'server-rejected',
      recovery: 'retry-operation',
      operation: 'turn-on-encryption',
    });
  });

  it('refuses without permission and asks nothing', async () => {
    const { svc, target, enable } = await setup({ alicePower: 0 });

    const error = await failure(firstValueFrom(svc.turnOn(target)));

    expect(error).toBeInstanceOf(RoomActionPermissionError);
    expect(enable).not.toHaveBeenCalled();
  });

  it('refuses when the opening account is gone', async () => {
    const { svc, target, enable, signIn } = await setup();
    signIn([]);

    const error = await failure(firstValueFrom(svc.turnOn(target)));

    expect((error as RoomAdministrationError).outcome.failure).toBe(
      'not-signed-in',
    );
    expect(enable).not.toHaveBeenCalled();
  });

  it('refuses a second request while the first is in flight, then frees the room', async () => {
    const { svc, target, enable } = await setup();
    const answer = new Subject<EngineResult<null>>();
    enable.mockReturnValueOnce(answer);

    const first = firstValueFrom(svc.turnOn(target), {
      defaultValue: undefined,
    });
    const second = await failure(firstValueFrom(svc.turnOn(target)));
    answer.next({ ok: true, value: null });
    answer.complete();
    await first;

    expect((second as RoomAdministrationError).outcome.failure).toBe(
      'invalid-input',
    );
    expect((second as Error).message).toBe(
      'Encryption is already being turned on.',
    );
    expect(enable).toHaveBeenCalledTimes(1);
    await firstValueFrom(svc.turnOn(target), { defaultValue: undefined });
    expect(enable).toHaveBeenCalledTimes(2);
  });
});
