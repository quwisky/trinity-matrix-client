import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { MatrixError, Visibility } from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  RoomActionPermissionError,
  RoomActionPermissionsService,
  type ActionAvailability,
} from './room-action-permissions.service';
import { RoomAdministrationError } from './room-administration-error';
import { RoomDirectoryService } from './room-directory.service';

const TARGET = { accountId: '@me:hs.example', roomId: '!room:hs' } as const;
const ALLOWED: ActionAvailability = { available: true, reason: null };

function setup(
  options: {
    directory?: ActionAvailability;
    signedIn?: boolean;
    visibility?: () => Promise<{ visibility: Visibility }>;
    set?: () => Promise<unknown>;
  } = {},
) {
  const getRoomDirectoryVisibility = vi.fn(
    options.visibility ??
      (() => Promise.resolve({ visibility: Visibility.Public })),
  );
  const setRoomDirectoryVisibility = vi.fn(
    options.set ?? (() => Promise.resolve({})),
  );
  const client = {
    getDomain: () => 'hs.example',
    getRoomDirectoryVisibility,
    setRoomDirectoryVisibility,
  };
  const settingsFor = vi.fn(() => ({
    directory: options.directory ?? ALLOWED,
    imagePack: ALLOWED,
    permissions: ALLOWED,
  }));
  TestBed.configureTestingModule({
    providers: [
      RoomDirectoryService,
      MockProvider(MatrixClientService, {
        clientFor: (accountId: string) =>
          options.signedIn !== false && accountId === TARGET.accountId
            ? (client as never)
            : null,
      }),
      MockProvider(RoomActionPermissionsService, {
        settingsFor: settingsFor as never,
        assert: (availability: ActionAvailability) => {
          if (!availability.available) {
            throw new RoomActionPermissionError(availability);
          }
        },
      }),
    ],
  });
  return {
    service: TestBed.inject(RoomDirectoryService),
    getRoomDirectoryVisibility,
    setRoomDirectoryVisibility,
    settingsFor,
  };
}

const failure = (cause: Promise<unknown>) =>
  cause.then(
    () => null,
    (error: unknown) => error,
  );

describe('RoomDirectoryService', () => {
  it("names the opening account's server", () => {
    const { service } = setup();

    expect(service.serverName(TARGET)).toBe('hs.example');
    expect(
      service.serverName({ accountId: '@gone:hs', roomId: TARGET.roomId }),
    ).toBeNull();
  });

  it('reads whether the room is listed, on subscribe', async () => {
    const { service, getRoomDirectoryVisibility } = setup({
      visibility: () => Promise.resolve({ visibility: Visibility.Private }),
    });

    const listed = service.listed(TARGET);
    expect(getRoomDirectoryVisibility).not.toHaveBeenCalled();

    await expect(firstValueFrom(listed)).resolves.toBe(false);
    expect(getRoomDirectoryVisibility).toHaveBeenCalledWith(TARGET.roomId);
  });

  it('reports a failed read as a typed error', async () => {
    const { service } = setup({
      visibility: () => Promise.reject(new Error('offline')),
    });

    const error = await failure(firstValueFrom(service.listed(TARGET)));

    expect((error as RoomAdministrationError).outcome).toMatchObject({
      failure: 'server-rejected',
      operation: 'load-directory-visibility',
    });
  });

  it.each([
    [true, Visibility.Public],
    [false, Visibility.Private],
  ])('sets listed=%s as %s for the opening account', async (listed, value) => {
    const { service, setRoomDirectoryVisibility, settingsFor } = setup();

    await firstValueFrom(service.setListed(TARGET, listed), {
      defaultValue: undefined,
    });

    expect(settingsFor).toHaveBeenCalledWith(TARGET);
    expect(setRoomDirectoryVisibility).toHaveBeenCalledExactlyOnceWith(
      TARGET.roomId,
      value,
    );
  });

  it('refuses without permission and changes nothing', async () => {
    const reason = "Your role cannot change this room's directory listing.";
    const { service, setRoomDirectoryVisibility } = setup({
      directory: { available: false, reason },
    });

    const error = await failure(
      firstValueFrom(service.setListed(TARGET, true)),
    );

    expect(error).toBeInstanceOf(RoomActionPermissionError);
    expect(setRoomDirectoryVisibility).not.toHaveBeenCalled();
  });

  it('refuses when the opening account is gone', async () => {
    const { service } = setup({ signedIn: false });

    const error = await failure(
      firstValueFrom(service.setListed(TARGET, true)),
    );

    expect((error as RoomAdministrationError).outcome.failure).toBe(
      'not-signed-in',
    );
  });

  it("explains a server that doesn't let this account publish", async () => {
    const { service } = setup({
      set: () =>
        Promise.reject(
          new MatrixError(
            { errcode: 'M_FORBIDDEN', error: 'Not allowed to publish room' },
            403,
          ),
        ),
    });

    const error = await failure(
      firstValueFrom(service.setListed(TARGET, true)),
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
    const { service } = setup({
      set: () =>
        Promise.reject(
          new MatrixError({ errcode: 'M_UNKNOWN', error: 'busy' }, 500),
        ),
    });

    const error = await failure(
      firstValueFrom(service.setListed(TARGET, false)),
    );

    expect((error as RoomAdministrationError).outcome).toMatchObject({
      failure: 'server-rejected',
      recovery: 'retry-operation',
      operation: 'set-directory-visibility',
    });
  });
});
