import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { EventType } from 'matrix-js-sdk';
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
  } = {},
) {
  const sendStateEvent = vi.fn(
    options.send ?? (() => Promise.resolve({ event_id: '$e' })),
  );
  const room = {
    roomId: TARGET.roomId,
    hasEncryptionStateEvent: () => options.encrypted ?? false,
  };
  const client = {
    sendStateEvent,
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
    sendStateEvent,
    settingsFor,
  };
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
});
