import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClient, MatrixError } from 'matrix-js-sdk';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import { MockProvider, ngMocks } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrustDevicesService } from './trust-devices.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

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

/** Writable so a test can drive an account switch; the projection re-wires off it. */
const activeUserId = signal<string | null>(null);

function setup(clientOverrides: Record<string, unknown> = {}) {
  activeUserId.set(null);
  const client = fakeClient(clientOverrides);
  TestBed.configureTestingModule({
    providers: [
      TrustDevicesService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: client as unknown as MatrixClient,
        activeUserId: activeUserId.asReadonly(),
      }),
    ],
  });
  const matrix = TestBed.inject(MatrixClientService);
  return { svc: TestBed.inject(TrustDevicesService), client, matrix };
}

describe('TrustDevicesService', () => {
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

    await expect(firstValueFrom(svc.delete('B', prompt))).rejects.toMatchObject(
      {
        operation: 'delete-device',
        kind: 'permission-denied',
        recovery: 'retry',
      },
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
      /remove this account/i,
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

    await expect(firstValueFrom(svc.delete('B', prompt))).rejects.toMatchObject(
      {
        operation: 'delete-device',
        kind: 'server-failure',
        recovery: 'retry',
      },
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

    await expect(firstValueFrom(svc.delete('B', prompt))).rejects.toMatchObject(
      {
        operation: 'delete-device',
        kind: 'provider-action-required',
        recovery: 'open-provider',
      },
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

  it('rebinds the device listener onto the newly-active account on a switch', () => {
    // TrustDevicesService takes no rebuild from the projection — it has no read model to
    // re-seed — so the switch behaviour worth pinning is that the listener follows the
    // active client rather than staying on the previous account's.
    const { svc, client, matrix } = setup();
    activeUserId.set('@a:hs');
    svc.connect();
    TestBed.inject(ApplicationRef).tick(); // effect's first run: still A
    client.off.mockClear();

    const clientB = fakeClient();
    ngMocks.stubMember(matrix, 'instance', clientB as unknown as MatrixClient);
    activeUserId.set('@b:hs');
    TestBed.inject(ApplicationRef).tick();

    expect(client.off).toHaveBeenCalled(); // detached from A
    expect(clientB.on).toHaveBeenCalled(); // attached to B
  });

  const ALL = { masterKey: true, selfSigningKey: true, userSigningKey: true };

  /** A client whose crypto reports `cached` private keys and the given identity reads. */
  function withKeys(
    cached: Record<string, boolean>,
    {
      ready = true,
      local = 'MASTER',
      published = 'MASTER' as string | null,
    } = {},
  ) {
    const crypto = {
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
      getCrossSigningStatus: vi.fn(async () => ({
        publicKeysOnDevice: true,
        privateKeysInSecretStorage: false,
        privateKeysCachedLocally: { ...cached },
      })),
      isCrossSigningReady: vi.fn(async () => ready),
      getCrossSigningKeyId: vi.fn(async () => local),
    };
    return {
      crypto,
      getCrypto: vi.fn(() => crypto),
      downloadKeysForUsers: vi.fn(async () => ({
        master_keys: published
          ? { '@me:hs': { keys: { ['ed25519:' + published]: published } } }
          : {},
      })),
    };
  }

  function onKeysChanged(client: { on: ReturnType<typeof vi.fn> }) {
    return client.on.mock.calls.find(
      ([event]) => event === CryptoEvent.KeysChanged,
    )?.[1] as () => void;
  }

  describe('canShareSecrets', () => {
    it('is true once all three private cross-signing keys are cached here', async () => {
      const { svc } = setup(withKeys(ALL));
      expect(svc.canShareSecrets()).toBe(false);

      await firstValueFrom(svc.list());

      await vi.waitFor(() => expect(svc.canShareSecrets()).toBe(true));
    });

    it('stays false while any one of the three is missing', async () => {
      const { svc } = setup(withKeys({ ...ALL, userSigningKey: false }));

      await firstValueFrom(svc.list());
      await new Promise((resolve) => setTimeout(resolve));

      expect(svc.canShareSecrets()).toBe(false);
    });

    it('stays false when the cached keys do not match the identity', async () => {
      const { svc } = setup(withKeys(ALL, { ready: false }));

      await firstValueFrom(svc.list());
      await new Promise((resolve) => setTimeout(resolve));

      expect(svc.canShareSecrets()).toBe(false);
    });

    it('refreshes when this account’s trust changes', async () => {
      const keys = withKeys({ ...ALL, masterKey: false });
      const { svc, client } = setup(keys);
      await firstValueFrom(svc.list());
      svc.connect();

      for (const event of [
        CryptoEvent.KeysChanged,
        CryptoEvent.UserTrustStatusChanged,
      ]) {
        expect(client.on).toHaveBeenCalledWith(event, expect.any(Function));
      }
      keys.crypto.getCrossSigningStatus.mockResolvedValue({
        publicKeysOnDevice: true,
        privateKeysInSecretStorage: false,
        privateKeysCachedLocally: ALL,
      });
      onKeysChanged(client)();

      await vi.waitFor(() => expect(svc.canShareSecrets()).toBe(true));
    });

    it('keeps the newest read when an older one answers last', async () => {
      const keys = withKeys(ALL);
      const { svc, client } = setup(keys);
      let answerOld!: (value: unknown) => void;
      keys.crypto.getCrossSigningStatus.mockReturnValueOnce(
        new Promise((resolve) => (answerOld = resolve)) as never,
      );
      await firstValueFrom(svc.list()); // starts the slow, older read
      svc.connect();
      onKeysChanged(client)(); // the newer read: all three cached
      await vi.waitFor(() => expect(svc.canShareSecrets()).toBe(true));

      answerOld({
        publicKeysOnDevice: true,
        privateKeysInSecretStorage: false,
        privateKeysCachedLocally: { ...ALL, masterKey: false },
      });
      await new Promise((resolve) => setTimeout(resolve));

      expect(svc.canShareSecrets()).toBe(true);
    });

    it('resets on an account switch', async () => {
      const { svc, matrix } = setup(withKeys(ALL));
      activeUserId.set('@a:hs');
      svc.connect();
      TestBed.inject(ApplicationRef).tick();
      await vi.waitFor(() => expect(svc.canShareSecrets()).toBe(true));

      // The next account's key read never answers, so only the reset can clear it.
      const next = withKeys(ALL);
      next.crypto.getCrossSigningStatus.mockReturnValue(
        new Promise(() => undefined) as never,
      );
      ngMocks.stubMember(
        matrix,
        'instance',
        fakeClient(next) as unknown as MatrixClient,
      );
      activeUserId.set('@b:hs');
      TestBed.inject(ApplicationRef).tick();

      expect(svc.canShareSecrets()).toBe(false);
    });
  });

  describe('holdsPublishedIdentity', () => {
    it('is true when the cached keys are the published identity', async () => {
      const keys = withKeys(ALL);
      const { svc, client } = setup(keys);

      expect(
        await firstValueFrom(svc.holdsPublishedIdentity(client as never)),
      ).toBe(true);
      expect(keys.downloadKeysForUsers).toHaveBeenCalledWith(['@me:hs']);
    });

    it.each([
      ['a local master key the server never published', { local: 'ROTATED' }],
      ['an account with no published identity', { published: null }],
      ['keys that do not match the identity', { ready: false }],
    ])('is false for %s', async (_case, options) => {
      const { svc, client } = setup(withKeys(ALL, options));

      expect(
        await firstValueFrom(svc.holdsPublishedIdentity(client as never)),
      ).toBe(false);
    });
  });
});
