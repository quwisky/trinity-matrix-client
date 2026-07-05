import { TestBed } from '@angular/core/testing';
import { MatrixClient, MatrixError } from 'matrix-js-sdk';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesService } from './devices.service';
import { MatrixClientService } from './matrix-client.service';

/** A UIA 401 carrying a password flow + session, like a homeserver returns. */
function uia(session: string): MatrixError {
  return new MatrixError(
    {
      errcode: 'M_FORBIDDEN',
      error: 'auth required',
      flows: [{ stages: ['m.login.password'] }],
      session,
    },
    401,
  );
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    getUserId: vi.fn(() => '@me:hs'),
    getDeviceId: vi.fn(() => 'A'),
    getCrypto: vi.fn(() => ({
      getDeviceVerificationStatus: vi.fn(async (_uid: string, did: string) => ({
        isVerified: () => did === 'A',
      })),
    })),
    getDevices: vi.fn().mockResolvedValue({
      devices: [
        {
          device_id: 'A',
          display_name: 'Laptop',
          last_seen_ts: 200,
          last_seen_ip: '1.2.3.4',
        },
        { device_id: 'B', last_seen_ts: 100 },
      ],
    }),
    setDeviceDetails: vi.fn().mockResolvedValue({}),
    deleteDevice: vi.fn().mockResolvedValue({}),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  };
}

function setup(clientOverrides: Record<string, unknown> = {}) {
  const client = fakeClient(clientOverrides);
  TestBed.configureTestingModule({
    providers: [
      DevicesService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: client as unknown as MatrixClient,
      }),
    ],
  });
  return { svc: TestBed.inject(DevicesService), client };
}

describe('DevicesService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists devices with verification + current flags, current first', async () => {
    const { svc } = setup();

    const devices = await firstValueFrom(svc.list());

    expect(devices.map((d) => d.id)).toEqual(['A', 'B']); // current first
    expect(devices[0]).toMatchObject({
      id: 'A',
      displayName: 'Laptop',
      isCurrent: true,
      isVerified: true,
      lastSeenIp: '1.2.3.4',
    });
    expect(devices[1]).toMatchObject({
      id: 'B',
      displayName: 'B', // falls back to the id
      isCurrent: false,
      isVerified: false,
    });
    expect(svc.devices()).toEqual(devices);
  });

  it('renames a device and patches the signal', async () => {
    const { svc, client } = setup();
    await firstValueFrom(svc.list());

    await firstValueFrom(svc.rename('B', '  Phone  '));

    expect(client.setDeviceDetails).toHaveBeenCalledWith('B', {
      display_name: 'Phone',
    });
    expect(svc.devices().find((d) => d.id === 'B')?.displayName).toBe('Phone');
  });

  it('deletes a device with no UIA and drops it from the signal', async () => {
    const { svc, client } = setup();
    await firstValueFrom(svc.list());

    await firstValueFrom(svc.delete('B', vi.fn()));

    expect(client.deleteDevice).toHaveBeenCalledTimes(1);
    expect(svc.devices().find((d) => d.id === 'B')).toBeUndefined();
  });

  it('completes the password UIA when the server challenges', async () => {
    const { svc, client } = setup();
    await firstValueFrom(svc.list());
    client.deleteDevice
      .mockRejectedValueOnce(uia('sess1')) // unauthenticated probe → challenge
      .mockResolvedValueOnce({}); // with auth → success
    const prompt = vi.fn().mockResolvedValue('hunter2');

    await firstValueFrom(svc.delete('B', prompt));

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(client.deleteDevice).toHaveBeenCalledTimes(2);
    expect(client.deleteDevice.mock.calls[1][1]).toMatchObject({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: '@me:hs' },
      password: 'hunter2',
      session: 'sess1',
    });
    expect(svc.devices().find((d) => d.id === 'B')).toBeUndefined();
  });

  it('re-prompts and gives up after too many wrong passwords', async () => {
    const { svc, client } = setup();
    await firstValueFrom(svc.list());
    client.deleteDevice.mockRejectedValue(uia('sess')); // always challenges
    const prompt = vi.fn().mockResolvedValue('wrong');

    await expect(firstValueFrom(svc.delete('B', prompt))).rejects.toThrow(
      /too many/i,
    );
    expect(prompt).toHaveBeenCalledTimes(3);
    // The device stays in the list since deletion never succeeded.
    expect(svc.devices().find((d) => d.id === 'B')).toBeDefined();
  });

  it('aborts silently (no error) when the password prompt is cancelled', async () => {
    const { svc, client } = setup();
    await firstValueFrom(svc.list());
    client.deleteDevice.mockRejectedValueOnce(uia('sess'));
    const prompt = vi.fn().mockResolvedValue(null);

    await expect(
      firstValueFrom(svc.delete('B', prompt)),
    ).resolves.toBeUndefined();
    expect(svc.devices().find((d) => d.id === 'B')).toBeDefined(); // not removed
  });

  it('refuses to delete the current device (logout territory)', async () => {
    const { svc, client } = setup(); // current device is 'A'
    await firstValueFrom(svc.list());
    const prompt = vi.fn();

    await expect(firstValueFrom(svc.delete('A', prompt))).rejects.toThrow(
      /log out/i,
    );
    expect(client.deleteDevice).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(svc.devices().find((d) => d.id === 'A')).toBeDefined();
  });

  it('degrades to unverified when a status check fails, without failing the list', async () => {
    const { svc } = setup({
      getCrypto: vi.fn(() => ({
        getDeviceVerificationStatus: vi.fn(
          async (_uid: string, did: string) => {
            if (did === 'A') {
              throw new Error('transient store error');
            }
            return { isVerified: () => false };
          },
        ),
      })),
    });

    const devices = await firstValueFrom(svc.list());

    expect(devices).toHaveLength(2); // one status threw, list still resolves
    expect(devices.find((d) => d.id === 'A')?.isVerified).toBe(false);
  });

  it('propagates a non-UIA delete failure without prompting', async () => {
    const { svc, client } = setup();
    await firstValueFrom(svc.list());
    client.deleteDevice.mockRejectedValueOnce(new Error('network down'));
    const prompt = vi.fn();

    await expect(firstValueFrom(svc.delete('B', prompt))).rejects.toThrow(
      /network down/,
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  it('bails with a clear error when no password stage is offered (SSO-only)', async () => {
    const { svc, client } = setup();
    await firstValueFrom(svc.list());
    client.deleteDevice.mockRejectedValueOnce(
      new MatrixError(
        { flows: [{ stages: ['m.login.sso'] }], session: 's' },
        401,
      ),
    );
    const prompt = vi.fn();

    await expect(firstValueFrom(svc.delete('B', prompt))).rejects.toThrow(
      /additional verification/i,
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  it('refetches only on the current user’s device change; disconnect detaches', async () => {
    const { svc, client } = setup();
    await firstValueFrom(svc.list());

    svc.connect();
    expect(client.on).toHaveBeenCalledWith(
      CryptoEvent.DevicesUpdated,
      expect.any(Function),
    );
    const handler = client.on.mock.calls.at(-1)?.[1] as (
      users: string[],
      initialFetch?: boolean,
    ) => void;

    client.getDevices.mockClear();
    handler(['@other:hs']); // a peer's devices changed → ignore
    expect(client.getDevices).not.toHaveBeenCalled();
    handler(['@me:hs'], true); // initial bulk fetch → ignore (list() already ran)
    expect(client.getDevices).not.toHaveBeenCalled();
    handler(['@me:hs']); // our own session list changed → refetch
    expect(client.getDevices).toHaveBeenCalled();

    svc.disconnect();
    expect(client.off).toHaveBeenCalledWith(
      CryptoEvent.DevicesUpdated,
      handler,
    );
  });

  it('a slow background reload cannot resurrect a just-removed device', async () => {
    const { svc, client } = setup();
    await firstValueFrom(svc.list()); // [A, B]
    svc.connect();
    const handler = client.on.mock.calls.at(-1)?.[1] as (u: string[]) => void;

    // The event-triggered reload is slow and would return the stale (pre-delete) list.
    let release!: (value: { devices: unknown[] }) => void;
    client.getDevices.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    handler(['@me:hs']); // starts the slow reload

    await firstValueFrom(svc.delete('B', vi.fn())); // removes B (bumps generation)
    expect(svc.devices().some((d) => d.id === 'B')).toBe(false);

    release({
      devices: [
        { device_id: 'A', display_name: 'Laptop', last_seen_ts: 200 },
        { device_id: 'B', last_seen_ts: 100 },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve)); // flush the stale reload

    expect(svc.devices().some((d) => d.id === 'B')).toBe(false); // not resurrected
  });
});
