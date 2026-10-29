import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  SESSION_SNAPSHOT,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import { Subject, concat, firstValueFrom, of, take } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { type EngineResult, engineFail } from '@trinity/util/matrix';
import { FakeTrustEngine } from '../contract/fake-trust-engine';
import type { OwnDevice, TrustFacts } from './trust-engine';
import { TRUST_ENGINE } from './trust-engine.token';
import { TrustDevicesService } from './trust-devices.service';

const BOB = '@bob:contract.invalid';

function sessionWith(active: string | null, accounts: readonly string[]) {
  return {
    activeAccountId: active,
    accounts: accounts.map((accountId) => ({
      accountId,
      deviceId: 'FAKEDEVICE',
      generation: 1,
      syncState: 'syncing' as const,
      serverSynced: true,
      roomsPrepared: true,
      waitingCount: 0,
      cryptoStoreEncrypted: true,
    })),
    softLoggedOut: [],
  } satisfies SessionSnapshot;
}

function setup() {
  const engine = new FakeTrustEngine();
  const alice = engine.alice;
  engine.addAccount(BOB);
  const laptop = engine.addDevice(alice, {
    displayName: 'Laptop',
    lastSeenTs: 200,
    lastSeenIp: '1.2.3.4',
    verified: true,
  });
  const phone = engine.addDevice(alice, { lastSeenTs: 100 });
  const session = signal<SessionSnapshot>(sessionWith(alice, [alice, BOB]));
  TestBed.configureTestingModule({
    providers: [
      { provide: TRUST_ENGINE, useValue: engine },
      { provide: SESSION_SNAPSHOT, useValue: session },
    ],
  });
  const svc = TestBed.inject(TrustDevicesService);
  return { svc, engine, alice, laptop, phone, session };
}

/** Lets a queued reconcile run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  TestBed.tick();
}

const ids = (svc: TrustDevicesService) => svc.devices().map((d) => d.id);

const HELD: Partial<TrustFacts> = {
  crossSigningReady: true,
  crossSigning: {
    publicKeysOnDevice: true,
    privateKeysInSecretStorage: false,
    privateKeysCachedLocally: {
      masterKey: true,
      selfSigningKey: true,
      userSigningKey: true,
    },
  },
};

describe('TrustDevicesService', () => {
  it('lists devices current first, then the most recently seen', async () => {
    const { svc, laptop, phone } = setup();

    const devices = await firstValueFrom(svc.list());

    expect(devices.map((d) => d.id)).toEqual(['FAKEDEVICE', laptop, phone]);
    expect(devices[0]).toMatchObject({ isCurrent: true });
    expect(devices[1]).toMatchObject({
      displayName: 'Laptop',
      isCurrent: false,
      isVerified: true,
      lastSeenIp: '1.2.3.4',
    });
    // A device without a name shows its id.
    expect(devices[2]).toMatchObject({ displayName: phone, isVerified: false });
    expect(svc.devices()).toEqual(devices);
  });

  it('reports a failed list as a TrustOperationError', async () => {
    const { svc, engine } = setup();
    vi.spyOn(engine, 'ownDevices').mockReturnValue(
      of(
        engineFail({
          kind: 'network',
          code: 'request-failed',
          diagnostic: { kind: 'network' },
        }),
      ),
    );

    await expect(firstValueFrom(svc.list())).rejects.toMatchObject({
      operation: 'list-devices',
      kind: 'server-failure',
    });
  });

  it('renames a device and patches the signal', async () => {
    const { svc, engine, alice, phone } = setup();
    const rename = vi.spyOn(engine, 'renameDevice');
    await firstValueFrom(svc.list());

    await firstValueFrom(svc.rename(phone, '  Phone  '));

    expect(rename).toHaveBeenCalledWith(alice, phone, 'Phone');
    expect(svc.devices().find((d) => d.id === phone)?.displayName).toBe(
      'Phone',
    );
  });

  it('deletes a device after the password prompt and drops it from the signal', async () => {
    const { svc, engine, phone } = setup();
    await firstValueFrom(svc.list());
    const prompt = vi.fn(async () => engine.password);

    await firstValueFrom(svc.delete(phone, prompt), {
      defaultValue: undefined,
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(ids(svc)).not.toContain(phone);
  });

  it('asks again after a rejected password, then deletes', async () => {
    const { svc, engine, phone } = setup();
    await firstValueFrom(svc.list());
    const prompt = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('wrong')
      .mockResolvedValueOnce(engine.password);

    await firstValueFrom(svc.delete(phone, prompt), {
      defaultValue: undefined,
    });

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(ids(svc)).not.toContain(phone);
  });

  it('gives up after three rejected passwords and keeps the device', async () => {
    const { svc, phone } = setup();
    await firstValueFrom(svc.list());
    const prompt = vi.fn(async () => 'wrong');

    await expect(
      firstValueFrom(svc.delete(phone, prompt)),
    ).rejects.toMatchObject({
      operation: 'delete-device',
      kind: 'permission-denied',
      recovery: 'retry',
      message: 'The homeserver did not accept the authentication attempt.',
    });
    expect(prompt).toHaveBeenCalledTimes(3);
    expect(ids(svc)).toContain(phone);
  });

  it('aborts silently when the password prompt is cancelled', async () => {
    const { svc, engine, phone } = setup();
    await firstValueFrom(svc.list());

    await expect(
      firstValueFrom(
        svc.delete(phone, async () => null),
        { defaultValue: undefined },
      ),
    ).resolves.toBeUndefined();
    expect(ids(svc)).toContain(phone);
    expect(engine.promptOpen()).toBe(false);
  });

  it('cancels the open prompt when the caller unsubscribes', async () => {
    const { svc, engine, phone } = setup();
    const subscription = svc
      .delete(phone, () => new Promise<string | null>(() => undefined))
      .subscribe();
    expect(engine.promptOpen()).toBe(true);

    subscription.unsubscribe();

    expect(engine.promptOpen()).toBe(false);
  });

  it('refuses to delete the current device (logout territory)', async () => {
    const { svc, engine } = setup();
    await firstValueFrom(svc.list());
    const deleteDevice = vi.spyOn(engine, 'deleteDevice');
    const prompt = vi.fn();

    await expect(
      firstValueFrom(svc.delete('FAKEDEVICE', prompt)),
    ).rejects.toThrow(/remove this account/i);
    expect(deleteDevice).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(ids(svc)).toContain('FAKEDEVICE');
  });

  it('asks the identity provider when no password stage is offered', async () => {
    const { svc, engine, alice, phone } = setup();
    engine.requireProviderAuth(alice);
    const prompt = vi.fn();

    await expect(
      firstValueFrom(svc.delete(phone, prompt)),
    ).rejects.toMatchObject({
      operation: 'delete-device',
      kind: 'provider-action-required',
      recovery: 'open-provider',
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('propagates a failed delete request without prompting', async () => {
    const { svc, engine, phone } = setup();
    vi.spyOn(engine, 'deleteDevice').mockReturnValue(
      of({
        kind: 'done',
        result: engineFail({
          kind: 'network',
          code: 'request-failed',
          diagnostic: { kind: 'network' },
        }),
      }),
    );
    const prompt = vi.fn();

    await expect(
      firstValueFrom(svc.delete(phone, prompt)),
    ).rejects.toMatchObject({
      operation: 'delete-device',
      kind: 'server-failure',
      recovery: 'retry',
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('follows the device list while connected; disconnect clears it', async () => {
    const { svc, engine, alice } = setup();
    svc.connect();
    await settle();
    expect(ids(svc)).toHaveLength(3);

    const tablet = engine.addDevice(alice);
    await settle();
    expect(ids(svc)).toContain(tablet);

    svc.disconnect();
    expect(svc.devices()).toEqual([]);
  });

  it('a list read before a removal cannot resurrect the device', async () => {
    const { svc, engine, alice, phone } = setup();
    await firstValueFrom(svc.list());
    const stale = engine.addDevice(alice); // only the stale read has it
    const slow = new Subject<EngineResult<readonly OwnDevice[]>>();
    const before = await firstValueFrom(engine.ownDevices(alice));
    vi.spyOn(engine, 'ownDevices').mockReturnValueOnce(slow);
    const reload = firstValueFrom(svc.list());

    await firstValueFrom(
      svc.delete(phone, async () => engine.password),
      {
        defaultValue: undefined,
      },
    );
    slow.next(before);
    await reload;

    expect(ids(svc)).not.toContain(phone);
    expect(ids(svc)).not.toContain(stale);
  });

  it('a trust change between a removal and the re-read does not bring the device back', async () => {
    const { svc, engine, alice, phone } = setup();
    // The re-read after the removal never answers, as on a slow server.
    const reread = new Subject<EngineResult<readonly OwnDevice[]>>();
    const devices = engine.ownDevices(alice);
    vi.spyOn(engine, 'ownDevices').mockReturnValue(
      concat(devices.pipe(take(1)), reread),
    );
    svc.connect();
    await settle();
    expect(ids(svc)).toContain(phone);

    await firstValueFrom(
      svc.delete(phone, async () => engine.password),
      {
        defaultValue: undefined,
      },
    );
    engine.setFacts(alice, HELD);
    await settle();

    expect(svc.canShareSecrets()).toBe(true);
    expect(ids(svc)).not.toContain(phone);
  });

  it('shows the own-device text when the engine refuses its own device', async () => {
    const { svc, engine, session, alice } = setup();
    session.set({
      ...sessionWith(alice, [alice]),
      accounts: sessionWith(alice, [alice]).accounts.map((a) => ({
        ...a,
        deviceId: null,
      })),
    });
    const prompt = vi.fn();

    await expect(
      firstValueFrom(svc.delete(engine.deviceIdOf(alice), prompt)),
    ).rejects.toMatchObject({
      operation: 'delete-device',
      kind: 'stale-state',
      message:
        'To sign out the device you are using, remove this account from the account menu.',
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('follows the newly active account on a switch', async () => {
    const { svc, engine, session } = setup();
    svc.connect();
    await settle();
    const tablet = engine.addDevice(BOB);

    session.set(sessionWith(BOB, [engine.alice, BOB]));
    TestBed.tick();
    await settle();

    expect(ids(svc)).toEqual(['FAKEDEVICE', tablet]);
  });

  describe('canShareSecrets', () => {
    it('is true once all three private keys are cached and match', async () => {
      const { svc, engine, alice } = setup();
      engine.setFacts(alice, HELD);
      expect(svc.canShareSecrets()).toBe(false);

      await firstValueFrom(svc.list());

      expect(svc.canShareSecrets()).toBe(true);
    });

    it.each([
      [
        'one of the three is missing',
        {
          ...HELD,
          crossSigning: {
            ...(HELD.crossSigning as TrustFacts['crossSigning']),
            privateKeysCachedLocally: {
              masterKey: true,
              selfSigningKey: true,
              userSigningKey: false,
            },
          },
        },
      ],
      [
        'the keys do not match the identity',
        { ...HELD, crossSigningReady: false },
      ],
    ])('stays false when %s', async (_case, facts) => {
      const { svc, engine, alice } = setup();
      engine.setFacts(alice, facts);

      await firstValueFrom(svc.list());

      expect(svc.canShareSecrets()).toBe(false);
    });

    it('follows trust changes while connected', async () => {
      const { svc, engine, alice } = setup();
      svc.connect();
      await settle();
      expect(svc.canShareSecrets()).toBe(false);

      engine.setFacts(alice, HELD);
      await settle();

      expect(svc.canShareSecrets()).toBe(true);
    });

    it('resets on an account switch', async () => {
      const { svc, engine, alice, session } = setup();
      engine.setFacts(alice, HELD);
      svc.connect();
      await settle();
      expect(svc.canShareSecrets()).toBe(true);

      session.set(sessionWith(BOB, [alice, BOB]));
      TestBed.tick();

      expect(svc.canShareSecrets()).toBe(false);
    });
  });

  describe('holdsPublishedIdentity', () => {
    it('is true when this device holds the published identity', async () => {
      const { svc, engine, alice } = setup();
      engine.publishIdentity(alice);

      expect(await firstValueFrom(svc.holdsPublishedIdentity(alice))).toBe(
        true,
      );
    });

    it('is false for an identity another device published', async () => {
      const { svc, engine, alice } = setup();
      engine.publishIdentityElsewhere(alice);

      expect(await firstValueFrom(svc.holdsPublishedIdentity(alice))).toBe(
        false,
      );
    });

    it('is false for an account with no published identity', async () => {
      const { svc, engine, alice } = setup();
      engine.setFacts(alice, HELD); // keys a cancelled setup left, never published

      expect(await firstValueFrom(svc.holdsPublishedIdentity(alice))).toBe(
        false,
      );
    });

    it('is false for an account without crypto', async () => {
      const { svc, engine } = setup();
      engine.addAccount('@carol:contract.invalid', { crypto: false });

      expect(
        await firstValueFrom(
          svc.holdsPublishedIdentity('@carol:contract.invalid'),
        ),
      ).toBe(false);
    });

    it('fails when the server cannot be asked', async () => {
      const { svc, engine, alice } = setup();
      vi.spyOn(engine, 'ownIdentityCheck').mockReturnValue(
        of(
          engineFail({
            kind: 'network',
            code: 'request-failed',
            diagnostic: { kind: 'network' },
          }),
        ),
      );

      await expect(
        firstValueFrom(svc.holdsPublishedIdentity(alice)),
      ).rejects.toThrow();
    });
  });

  it('never runs a command before it is subscribed', () => {
    const { svc, engine, phone } = setup();
    const rename = vi.spyOn(engine, 'renameDevice');
    const remove = vi.spyOn(engine, 'deleteDevice');

    svc.rename(phone, 'x');
    svc.delete(phone, vi.fn());

    expect(rename).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
