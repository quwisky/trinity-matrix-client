import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { EventType, MatrixError, type MatrixEvent } from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  RoomActionPermissionError,
  RoomActionPermissionsService,
  type ActionAvailability,
} from './room-action-permissions.service';
import { RoomAdministrationError } from './room-administration-error';
import { RoomEncryptionService } from './room-encryption.service';

const TARGET = { accountId: '@me:hs', roomId: '!room:hs' } as const;
const ALLOWED: ActionAvailability = { available: true, reason: null };

function setup(
  options: {
    encrypted?: boolean;
    encryption?: ActionAvailability;
    signedIn?: boolean;
    send?: () => Promise<unknown>;
    serverState?: () => Promise<unknown>;
    store?: () => Promise<boolean>;
    /** The store's answer once the local apply has run. */
    applied?: () => Promise<boolean>;
    onCryptoEvent?: ((...args: unknown[]) => Promise<void>) | null;
  } = {},
) {
  let afterApply = false;
  const onCryptoEvent = vi.fn(
    options.onCryptoEvent ??
      (async () => {
        afterApply = true;
      }),
  );
  const getStateEvent = vi.fn(
    options.serverState ??
      (() =>
        Promise.reject(
          new MatrixError(
            { errcode: 'M_NOT_FOUND', error: 'Event not found.' },
            404,
          ),
        )),
  );
  const sendStateEvent = vi.fn(
    options.send ?? (() => Promise.resolve({ event_id: '$e' })),
  );
  const room = {
    roomId: TARGET.roomId,
    hasEncryptionStateEvent: () => options.encrypted ?? false,
  };
  const client = {
    getStateEvent,
    sendStateEvent,
    getCrypto: () => ({
      isEncryptionEnabledInRoom: () =>
        afterApply
          ? (options.applied ?? (() => Promise.resolve(true)))()
          : (options.store ?? (() => Promise.resolve(false)))(),
      ...(options.onCryptoEvent === null ? {} : { onCryptoEvent }),
    }),
    getRoom: (roomId: string) => (roomId === TARGET.roomId ? room : null),
  };
  const settingsFor = vi.fn(() => ({
    encryption: options.encryption ?? ALLOWED,
  }));
  TestBed.configureTestingModule({
    providers: [
      RoomEncryptionService,
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
    service: TestBed.inject(RoomEncryptionService),
    getStateEvent,
    sendStateEvent,
    settingsFor,
    onCryptoEvent,
    room,
  };
}

async function notAppliedError(
  options: Parameters<typeof setup>[0],
): Promise<RoomAdministrationError> {
  const { service, sendStateEvent } = setup(options);
  const error = await firstValueFrom(service.turnOn(TARGET)).catch(
    (cause: unknown) => cause,
  );
  expect(sendStateEvent).toHaveBeenCalledTimes(1);
  expect(error).toBeInstanceOf(RoomAdministrationError);
  return error as RoomAdministrationError;
}

describe('RoomEncryptionService', () => {
  it('sends the Megolm m.room.encryption content new rooms are created with', async () => {
    const { service, sendStateEvent, settingsFor } = setup();

    await firstValueFrom(service.turnOn(TARGET), { defaultValue: undefined });

    expect(settingsFor).toHaveBeenCalledWith(TARGET);
    expect(sendStateEvent).toHaveBeenCalledExactlyOnceWith(
      TARGET.roomId,
      EventType.RoomEncryption,
      { algorithm: 'm.megolm.v1.aes-sha2' },
      '',
    );
  });

  it('is cold: nothing is sent until subscribed', () => {
    const { service, sendStateEvent } = setup();

    service.turnOn(TARGET);

    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('refuses an already encrypted room without re-sending its settings', async () => {
    const { service, sendStateEvent } = setup({ encrypted: true });

    const error = await firstValueFrom(service.turnOn(TARGET)).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(RoomAdministrationError);
    expect((error as RoomAdministrationError).outcome.failure).toBe(
      'invalid-input',
    );
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('sends no second m.room.encryption when only the crypto store knows the room is encrypted', async () => {
    const { service, sendStateEvent } = setup({
      store: () => Promise.resolve(true),
    });

    const error = await firstValueFrom(service.turnOn(TARGET)).catch(
      (cause: unknown) => cause,
    );

    expect((error as Error).message).toBe('This room is already encrypted.');
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('sends nothing when the crypto store fails to answer', async () => {
    const { service, sendStateEvent } = setup({
      store: () => Promise.reject(new Error('store unavailable')),
    });

    const error = await firstValueFrom(service.turnOn(TARGET)).catch(
      (cause: unknown) => cause,
    );

    expect((error as Error).message).toBe('This room is already encrypted.');
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('asks the server first, so a missed sync never sends a second event', async () => {
    const { service, getStateEvent, sendStateEvent } = setup({
      serverState: () => Promise.resolve({ algorithm: 'm.megolm.v1.aes-sha2' }),
    });

    const error = await firstValueFrom(service.turnOn(TARGET)).catch(
      (cause: unknown) => cause,
    );

    expect(getStateEvent).toHaveBeenCalledWith(
      TARGET.roomId,
      EventType.RoomEncryption,
      '',
    );
    expect((error as RoomAdministrationError).outcome.failure).toBe(
      'invalid-input',
    );
    expect((error as Error).message).toBe('This room is already encrypted.');
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('sends nothing when the server state cannot be read', async () => {
    const { service, sendStateEvent } = setup({
      serverState: () =>
        Promise.reject(
          new MatrixError({ errcode: 'M_UNKNOWN', error: 'busy' }, 500),
        ),
    });

    const error = await firstValueFrom(service.turnOn(TARGET)).catch(
      (cause: unknown) => cause,
    );

    expect((error as RoomAdministrationError).outcome.failure).toBe(
      'server-rejected',
    );
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('refuses without permission and sends nothing', async () => {
    const reason =
      'Only people who can change room settings can turn on encryption.';
    const { service, sendStateEvent } = setup({
      encryption: { available: false, reason },
    });

    const error = await firstValueFrom(service.turnOn(TARGET)).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(RoomActionPermissionError);
    expect((error as Error).message).toBe(reason);
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('refuses when the opening account is gone', async () => {
    const { service, sendStateEvent } = setup({ signedIn: false });

    const error = await firstValueFrom(service.turnOn(TARGET)).catch(
      (cause: unknown) => cause,
    );

    expect((error as RoomAdministrationError).outcome.failure).toBe(
      'not-signed-in',
    );
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('refuses a second request while the first is in flight', async () => {
    let resolve!: (value: unknown) => void;
    const { service, sendStateEvent } = setup({
      send: () => new Promise((done) => (resolve = done)),
    });

    const first = firstValueFrom(service.turnOn(TARGET), {
      defaultValue: undefined,
    });
    const second = await firstValueFrom(service.turnOn(TARGET)).catch(
      (cause: unknown) => cause,
    );
    await vi.waitFor(() => expect(sendStateEvent).toHaveBeenCalled());
    resolve({ event_id: '$e' });
    await first;

    expect((second as RoomAdministrationError).outcome.failure).toBe(
      'invalid-input',
    );
    expect(sendStateEvent).toHaveBeenCalledTimes(1);
  });

  it('reports a server rejection as a retryable typed error', async () => {
    const { service } = setup({
      send: () => Promise.reject(new Error('M_FORBIDDEN')),
    });

    const error = await firstValueFrom(service.turnOn(TARGET)).catch(
      (cause: unknown) => cause,
    );

    expect((error as RoomAdministrationError).outcome).toMatchObject({
      failure: 'server-rejected',
      recovery: 'retry-operation',
      operation: 'turn-on-encryption',
    });
  });

  it('applies the sent content to this device once the server accepts it', async () => {
    const { service, onCryptoEvent, room } = setup();

    await firstValueFrom(service.turnOn(TARGET), { defaultValue: undefined });

    expect(onCryptoEvent).toHaveBeenCalledTimes(1);
    const [appliedRoom, event] = onCryptoEvent.mock.calls[0] as [
      unknown,
      MatrixEvent,
    ];
    expect(appliedRoom).toBe(room);
    expect(event.getType()).toBe(EventType.RoomEncryption);
    expect(event.getStateKey()).toBe('');
    expect(event.getRoomId()).toBe(TARGET.roomId);
    expect(event.getContent()).toEqual({ algorithm: 'm.megolm.v1.aes-sha2' });
  });

  it('applies nothing when the server rejects the event', async () => {
    const { service, onCryptoEvent } = setup({
      send: () => Promise.reject(new Error('M_FORBIDDEN')),
    });

    await firstValueFrom(service.turnOn(TARGET)).catch(() => undefined);

    expect(onCryptoEvent).not.toHaveBeenCalled();
  });

  it('applies nothing to a room that is already encrypted', async () => {
    for (const options of [
      { encrypted: true },
      { store: () => Promise.resolve(true) },
      {
        serverState: () =>
          Promise.resolve({ algorithm: 'm.megolm.v1.aes-sha2' }),
      },
    ]) {
      TestBed.resetTestingModule();
      const { service, onCryptoEvent } = setup(options);

      await firstValueFrom(service.turnOn(TARGET)).catch(() => undefined);

      expect(onCryptoEvent).not.toHaveBeenCalled();
    }
  });

  it('reports a partial update when the crypto backend cannot apply it', async () => {
    const error = await notAppliedError({ onCryptoEvent: null });

    expect(error.outcome).toMatchObject({
      failure: 'partial-update',
      operation: 'turn-on-encryption',
    });
  });

  it('reports a partial update when applying it throws', async () => {
    const error = await notAppliedError({
      onCryptoEvent: () => Promise.reject(new Error('encryptor mismatch')),
    });

    expect(error.outcome.failure).toBe('partial-update');
  });

  it('reports a partial update when the crypto store does not read back as encrypted', async () => {
    const error = await notAppliedError({
      applied: () => Promise.resolve(false),
    });

    expect(error.outcome.failure).toBe('partial-update');
  });
});
