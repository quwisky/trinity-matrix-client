import { TestBed } from '@angular/core/testing';
import { type EngineFailure, engineFail } from '@trinity/util/matrix';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomActionPermissionError } from './room-action-permissions.service';
import { RoomAdministrationError } from './room-administration-error';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';
import {
  administrationSession,
  roomWithAlice,
} from './room-administration.spec-harness';
import { RoomDirectoryService } from './room-directory.service';

/** Alice at `alicePower` in bob's room; the directory listing needs 50. */
async function setup({ alicePower = 100 }: { alicePower?: number } = {}) {
  const session = administrationSession();
  const { engine } = session;
  const roomId = await roomWithAlice(engine);
  await engine.asBob.setPowerLevel(roomId, engine.alice, alicePower);
  TestBed.configureTestingModule({ providers: session.providers });
  const state = TestBed.inject(RoomAdministrationProjectionState);
  state.select(engine.alice, roomId);
  state.update('permissions', 'available', 'retained');
  return {
    ...session,
    target: { accountId: engine.alice, roomId },
    service: TestBed.inject(RoomDirectoryService),
  };
}

const failure = (cause: Promise<unknown>) =>
  cause.then(
    () => null,
    (error: unknown) => error,
  );

const refusal = (httpStatus: number, errcode: string): EngineFailure => ({
  kind: httpStatus === 403 ? 'permission' : 'server',
  code: 'request-failed',
  diagnostic: {
    kind: httpStatus === 403 ? 'permission' : 'server',
    httpStatus,
    errcode,
  },
});

afterEach(() => TestBed.resetTestingModule());

describe('RoomDirectoryService', () => {
  it("names the opening account's server", async () => {
    const { service, target } = await setup();

    expect(service.serverName(target)).toBe('example.org');
    expect(
      service.serverName({ accountId: '@gone:hs', roomId: target.roomId }),
    ).toBeNull();
  });

  it('reads whether the room is listed, on subscribe', async () => {
    const { service, engine, target } = await setup();
    const directoryVisibility = vi.spyOn(engine, 'directoryVisibility');

    const listed = service.listed(target);
    expect(directoryVisibility).not.toHaveBeenCalled();

    await expect(firstValueFrom(listed)).resolves.toBe(false);
    expect(directoryVisibility).toHaveBeenCalledWith(
      engine.alice,
      target.roomId,
    );
  });

  it('reports a failed read as a typed error', async () => {
    const { service, engine } = await setup();

    const error = await failure(
      firstValueFrom(
        service.listed({ accountId: engine.alice, roomId: '!unknown:hs' }),
      ),
    );

    expect((error as RoomAdministrationError).outcome).toMatchObject({
      failure: 'server-rejected',
      operation: 'load-directory-visibility',
    });
  });

  it.each([
    [true, 'public'],
    [false, 'private'],
  ] as const)(
    'sets listed=%s as %s for the opening account',
    async (listed, value) => {
      const { service, engine, target } = await setup();
      const setDirectoryVisibility = vi.spyOn(engine, 'setDirectoryVisibility');

      await firstValueFrom(service.setListed(target, listed), {
        defaultValue: undefined,
      });

      expect(setDirectoryVisibility).toHaveBeenCalledExactlyOnceWith(
        engine.alice,
        target.roomId,
        value,
      );
      await expect(firstValueFrom(service.listed(target))).resolves.toBe(
        listed,
      );
    },
  );

  it('refuses without permission and changes nothing', async () => {
    const { service, engine, target } = await setup({ alicePower: 0 });
    const setDirectoryVisibility = vi.spyOn(engine, 'setDirectoryVisibility');

    const error = await failure(
      firstValueFrom(service.setListed(target, true)),
    );

    expect(error).toBeInstanceOf(RoomActionPermissionError);
    expect(setDirectoryVisibility).not.toHaveBeenCalled();
  });

  it('refuses when the opening account is gone', async () => {
    const { service, target } = await setup();

    const error = await failure(
      firstValueFrom(
        service.setListed(
          { accountId: '@gone:hs', roomId: target.roomId },
          true,
        ),
      ),
    );

    expect((error as RoomAdministrationError).outcome.failure).toBe(
      'not-signed-in',
    );
  });

  it("explains a server that doesn't let this account publish", async () => {
    const { service, engine, target } = await setup();
    vi.spyOn(engine, 'setDirectoryVisibility').mockReturnValue(
      of(engineFail(refusal(403, 'M_UNKNOWN'))),
    );

    const error = await failure(
      firstValueFrom(service.setListed(target, true)),
    );

    expect(error).toBeInstanceOf(RoomAdministrationError);
    expect((error as RoomAdministrationError).outcome.failure).toBe(
      'permission-denied',
    );
    expect((error as Error).message).toBe(
      "Your server doesn't let you list rooms in its directory.",
    );
  });

  it('keeps any other rejection retryable', async () => {
    const { service, engine, target } = await setup();
    vi.spyOn(engine, 'setDirectoryVisibility').mockReturnValue(
      of(engineFail(refusal(500, 'M_UNKNOWN'))),
    );

    const error = await failure(
      firstValueFrom(service.setListed(target, false)),
    );

    expect((error as RoomAdministrationError).outcome).toMatchObject({
      failure: 'server-rejected',
      recovery: 'retry-operation',
      operation: 'set-directory-visibility',
    });
  });
});
