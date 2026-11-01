import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { MatrixClient } from 'matrix-js-sdk';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import { MockProvider, ngMocks } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrustOperationError } from './trust-operation-error';
import { TrustUsersService, type UserSession } from './trust-users.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

const ALICE = '@alice:hs';
const BOB = '@bob:hs';

interface Status {
  isCrossSigningVerified(): boolean;
  wasCrossSigningVerified(): boolean;
  readonly needsUserApproval: boolean;
}

const status = (is: boolean, was: boolean, approve = false): Status => ({
  isCrossSigningVerified: () => is,
  wasCrossSigningVerified: () => was,
  needsUserApproval: approve,
});

interface FakeDevice {
  readonly deviceId: string;
  readonly displayName?: string;
  readonly dehydrated?: boolean;
}

/** `isVerified()` mirrors the SDK, so a test can tell which of the two fields was read. */
const deviceStatus = (
  crossSigningVerified: boolean,
  localVerified = false,
) => ({
  crossSigningVerified,
  localVerified,
  isVerified: () => localVerified || crossSigningVerified,
});

const deviceMap = (userId: string, devices: readonly FakeDevice[]) =>
  new Map([[userId, new Map(devices.map((d) => [d.deviceId, d]))]]);

const PHONE: FakeDevice = { deviceId: 'PHONE', displayName: 'Phone' };
const LAPTOP: FakeDevice = { deviceId: 'LAPTOP', displayName: 'Laptop' };

function fakeClient(
  read: (userId: string) => Promise<Status> = async () => status(false, false),
  crypto = true,
  sessions: {
    readonly devices?: (
      userIds: string[],
      download?: boolean,
    ) => Promise<ReturnType<typeof deviceMap>>;
    readonly device?: (
      userId: string,
      deviceId: string,
    ) => Promise<ReturnType<typeof deviceStatus> | null>;
  } = {},
) {
  const getUserVerificationStatus = vi.fn(read);
  const getUserDeviceInfo = vi.fn(
    sessions.devices ??
      (async (userIds: string[]) => deviceMap(userIds[0] ?? '', [])),
  );
  const getDeviceVerificationStatus = vi.fn(
    sessions.device ?? (async () => deviceStatus(false)),
  );
  const pinCurrentUserIdentity = vi.fn(async (_userId: string) => undefined);
  const withdrawVerificationRequirement = vi.fn(
    async (_userId: string) => undefined,
  );
  return {
    getUserId: vi.fn(() => '@me:hs'),
    getCrypto: vi.fn(() =>
      crypto
        ? {
            getUserVerificationStatus,
            getUserDeviceInfo,
            getDeviceVerificationStatus,
            pinCurrentUserIdentity,
            withdrawVerificationRequirement,
          }
        : undefined,
    ),
    getUserVerificationStatus,
    getUserDeviceInfo,
    getDeviceVerificationStatus,
    pinCurrentUserIdentity,
    withdrawVerificationRequirement,
    on: vi.fn(),
    off: vi.fn(),
  };
}

const activeUserId = signal<string | null>(null);

function setup(client = fakeClient()) {
  activeUserId.set('@me:hs');
  TestBed.configureTestingModule({
    providers: [
      TrustUsersService,
      MockProvider(MatrixClientService, {
        activeUserId: activeUserId.asReadonly(),
      }),
    ],
  });
  const matrix = TestBed.inject(MatrixClientService);
  ngMocks.stubMember(matrix, 'instance', client as unknown as MatrixClient);
  ngMocks.stubMember(matrix, 'isInitialized', true);
  return { svc: TestBed.inject(TrustUsersService), client, matrix };
}

/** The `UserTrustStatusChanged` handler the service bound on the client. */
function trustHandler(client: ReturnType<typeof fakeClient>) {
  return client.on.mock.calls.find(
    (c) => c[0] === CryptoEvent.UserTrustStatusChanged,
  )?.[1] as (userId: string, next: Status) => void;
}

/** The `DevicesUpdated` handler the service bound on the client. */
function devicesHandler(client: ReturnType<typeof fakeClient>) {
  return client.on.mock.calls.find(
    (c) => c[0] === CryptoEvent.DevicesUpdated,
  )?.[1] as (users: string[], initialFetch: boolean) => void;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('TrustUsersService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('returns verified when the user is cross-signing verified', async () => {
    const { svc } = setup(fakeClient(async () => status(true, true)));
    const lifetime = svc.runProjection().subscribe();
    const trust = svc.userTrust(ALICE);
    await settle();
    expect(trust()).toBe('verified');
    expect(svc.userTrust(ALICE)).toBe(trust);
    lifetime.unsubscribe();
  });

  it('returns verified-identity-changed when a previously verified identity is no longer verified', async () => {
    const { svc } = setup(fakeClient(async () => status(false, true, true)));
    const lifetime = svc.runProjection().subscribe();
    const trust = svc.userTrust(ALICE);
    await settle();
    expect(trust()).toBe('verified-identity-changed');
    lifetime.unsubscribe();
  });

  it('returns identity-changed when an unverified identity needs approval', async () => {
    const { svc } = setup(fakeClient(async () => status(false, false, true)));
    const lifetime = svc.runProjection().subscribe();
    const trust = svc.userTrust(ALICE);
    await settle();
    expect(trust()).toBe('identity-changed');
    lifetime.unsubscribe();
  });

  it('returns unverified for a user never verified', async () => {
    const { svc } = setup(fakeClient(async () => status(false, false)));
    const lifetime = svc.runProjection().subscribe();
    const trust = svc.userTrust(ALICE);
    await settle();
    expect(trust()).toBe('unverified');
    lifetime.unsubscribe();
  });

  it('returns unverified when the status read fails', async () => {
    const { svc } = setup(
      fakeClient(() => Promise.reject(new Error('store closed'))),
    );
    const lifetime = svc.runProjection().subscribe();
    const trust = svc.userTrust(ALICE);
    await settle();
    expect(trust()).toBe('unverified');
    lifetime.unsubscribe();
  });

  it('refreshes on UserTrustStatusChanged for that user only', async () => {
    const { svc, client } = setup(fakeClient(async () => status(false, false)));
    const lifetime = svc.runProjection().subscribe();
    const trust = svc.userTrust(ALICE);
    await settle();
    expect(trust()).toBe('unverified');

    trustHandler(client)(BOB, status(true, true));
    await settle();
    expect(trust()).toBe('unverified');

    trustHandler(client)(ALICE, status(true, true));
    await settle();
    expect(trust()).toBe('verified');
    lifetime.unsubscribe();
  });

  it('discards a slower earlier read once a newer status has arrived', async () => {
    let resolveFirst: (s: Status) => void = () => undefined;
    const { svc, client } = setup(
      fakeClient(
        () => new Promise<Status>((resolve) => (resolveFirst = resolve)),
      ),
    );
    const lifetime = svc.runProjection().subscribe();
    const trust = svc.userTrust(ALICE);

    trustHandler(client)(ALICE, status(true, true));
    resolveFirst(status(false, false));
    await settle();
    expect(trust()).toBe('verified');
    lifetime.unsubscribe();
  });

  it('is null while crypto is unavailable and after an account switch', async () => {
    const { svc, matrix } = setup(
      fakeClient(async () => status(true, true), false),
    );
    const lifetime = svc.runProjection().subscribe();
    const trust = svc.userTrust(ALICE);
    await settle();
    expect(trust()).toBeNull();

    const clientA = fakeClient(async () => status(true, true));
    ngMocks.stubMember(matrix, 'instance', clientA as unknown as MatrixClient);
    activeUserId.set('@a:hs');
    TestBed.inject(ApplicationRef).tick();
    await settle();
    expect(trust()).toBe('verified');

    const clientB = fakeClient(() => new Promise<Status>(() => undefined));
    ngMocks.stubMember(matrix, 'instance', clientB as unknown as MatrixClient);
    activeUserId.set('@b:hs');
    TestBed.inject(ApplicationRef).tick();
    await settle();
    expect(trust()).toBeNull();

    lifetime.unsubscribe();
  });

  it('is null when no projection is running', async () => {
    const { svc } = setup(fakeClient(async () => status(true, true)));
    const trust = svc.userTrust(ALICE);
    await settle();
    expect(trust()).toBeNull();
  });

  describe('userSessions', () => {
    const start = (client: ReturnType<typeof fakeClient>) => {
      const { svc, matrix } = setup(client);
      const lifetime = svc.runProjection().subscribe();
      return { svc, matrix, lifetime, sessions: svc.userSessions(ALICE) };
    };

    it('reads locally for the first paint, without the network', async () => {
      const client = fakeClient(undefined, true, {
        devices: async () => deviceMap(ALICE, [PHONE]),
      });
      const { sessions, svc, lifetime } = start(client);
      expect(sessions()).toEqual({ kind: 'unknown' });
      await settle();

      expect(client.getUserDeviceInfo).toHaveBeenCalledExactlyOnceWith(
        [ALICE],
        false,
      );
      expect(sessions()).toEqual({
        kind: 'unchecked',
        sessions: [{ deviceId: 'PHONE', shownId: 'PHONE', name: 'Phone' }],
      });
      expect(svc.userSessions(ALICE)).toBe(sessions);
      lifetime.unsubscribe();
    });

    it('stays unknown when the local read is empty or fails', async () => {
      const empty = start(fakeClient());
      await settle();
      expect(empty.sessions()).toEqual({ kind: 'unknown' });
      empty.lifetime.unsubscribe();

      TestBed.resetTestingModule();
      const failing = start(
        fakeClient(undefined, true, {
          devices: () => Promise.reject(new Error('store closed')),
        }),
      );
      await settle();
      expect(failing.sessions()).toEqual({ kind: 'unknown' });
      failing.lifetime.unsubscribe();
    });

    it('reads over the network only once opened, showing loading first', async () => {
      let answer: (devices: ReturnType<typeof deviceMap>) => void = () =>
        undefined;
      const client = fakeClient(undefined, true, {
        devices: (_ids, download) =>
          download
            ? new Promise((resolve) => (answer = resolve))
            : Promise.resolve(deviceMap(ALICE, [])),
      });
      const { sessions, svc, lifetime } = start(client);
      await settle();
      expect(client.getUserDeviceInfo).not.toHaveBeenCalledWith([ALICE], true);

      svc.loadUserSessions(ALICE);
      expect(client.getUserDeviceInfo).toHaveBeenLastCalledWith([ALICE], true);
      expect(sessions()).toEqual({ kind: 'loading' });

      answer(deviceMap(ALICE, [PHONE]));
      await settle();
      expect(sessions()).toMatchObject({ kind: 'unchecked' });
      lifetime.unsubscribe();
    });

    it('does not read again when opened a second time', async () => {
      const client = fakeClient(undefined, true, {
        devices: async () => deviceMap(ALICE, [PHONE]),
      });
      const { svc, lifetime } = start(client);
      await settle();

      svc.loadUserSessions(ALICE);
      await settle();
      svc.loadUserSessions(ALICE);
      await settle();

      expect(
        client.getUserDeviceInfo.mock.calls.filter(([, download]) => download),
      ).toHaveLength(1);
      lifetime.unsubscribe();
    });

    it('lists an empty network read instead of staying unknown', async () => {
      const { sessions, svc, lifetime } = start(fakeClient());
      await settle();

      svc.loadUserSessions(ALICE);
      await settle();

      expect(sessions()).toEqual({ kind: 'unchecked', sessions: [] });
      lifetime.unsubscribe();
    });

    it('drops a late answer once a newer read has started', async () => {
      const answers: ((devices: ReturnType<typeof deviceMap>) => void)[] = [];
      const client = fakeClient(undefined, true, {
        devices: () => new Promise((resolve) => answers.push(resolve)),
      });
      const { sessions, svc, lifetime } = start(client);

      svc.loadUserSessions(ALICE);
      answers[1]?.(deviceMap(ALICE, [PHONE, LAPTOP]));
      await settle();
      answers[0]?.(deviceMap(ALICE, [PHONE]));
      await settle();

      expect(sessions()).toMatchObject({
        sessions: [{ deviceId: 'LAPTOP' }, { deviceId: 'PHONE' }],
      });
      lifetime.unsubscribe();
    });

    it('drops a late failure once a newer read has started', async () => {
      const rejections: ((error: Error) => void)[] = [];
      const client = fakeClient(undefined, true, {
        devices: (_ids, download) =>
          download
            ? new Promise((_resolve, reject) => rejections.push(reject))
            : Promise.resolve(deviceMap(ALICE, [])),
      });
      const { sessions, svc, lifetime } = start(client);
      await settle();
      svc.loadUserSessions(ALICE);
      client.getUserDeviceInfo.mockResolvedValue(deviceMap(ALICE, [PHONE]));
      devicesHandler(client)([ALICE], false);
      await settle();

      rejections[0]?.(new Error('late'));
      await settle();

      expect(sessions()).toMatchObject({ kind: 'unchecked' });
      lifetime.unsubscribe();
    });

    it('re-reads on DevicesUpdated, only for a listed user', async () => {
      const client = fakeClient(undefined, true, {
        devices: async () => deviceMap(ALICE, [PHONE]),
      });
      const { sessions, lifetime } = start(client);
      await settle();
      const reads = client.getUserDeviceInfo.mock.calls.length;

      devicesHandler(client)([BOB], false);
      await settle();
      expect(client.getUserDeviceInfo).toHaveBeenCalledTimes(reads);

      client.getUserDeviceInfo.mockResolvedValue(
        deviceMap(ALICE, [PHONE, LAPTOP]),
      );
      devicesHandler(client)([BOB, ALICE], false);
      await settle();
      expect(sessions()).toMatchObject({
        sessions: [{ deviceId: 'LAPTOP' }, { deviceId: 'PHONE' }],
      });
      lifetime.unsubscribe();
    });

    it('re-reads on UserTrustStatusChanged, so the states follow', async () => {
      let verified = false;
      const client = fakeClient(undefined, true, {
        devices: async () => deviceMap(ALICE, [PHONE]),
        device: async () => deviceStatus(verified),
      });
      const { sessions, lifetime } = start(client);
      await settle();
      expect(sessions()).toMatchObject({ kind: 'unchecked' });

      verified = true;
      trustHandler(client)(ALICE, status(true, true));
      await settle();

      expect(sessions()).toEqual({
        kind: 'checked',
        notVerified: 0,
        sessions: [
          {
            deviceId: 'PHONE',
            shownId: 'PHONE',
            name: 'Phone',
            verified: true,
          },
        ],
      });
      lifetime.unsubscribe();
    });

    it('keeps using the network for re-reads once opened', async () => {
      const client = fakeClient(undefined, true, {
        devices: async () => deviceMap(ALICE, [PHONE]),
      });
      const { svc, lifetime } = start(client);
      await settle();
      devicesHandler(client)([ALICE], false);
      await settle();
      expect(client.getUserDeviceInfo).toHaveBeenLastCalledWith([ALICE], false);

      svc.loadUserSessions(ALICE);
      await settle();
      devicesHandler(client)([ALICE], false);
      await settle();
      expect(client.getUserDeviceInfo).toHaveBeenLastCalledWith([ALICE], true);
      lifetime.unsubscribe();
    });

    it('degrades only the session whose status read failed', async () => {
      const client = fakeClient(async () => status(true, true), true, {
        devices: async () => deviceMap(ALICE, [PHONE, LAPTOP]),
        device: (_userId, deviceId) =>
          deviceId === 'PHONE'
            ? Promise.reject(new Error('store closed'))
            : Promise.resolve(deviceStatus(true)),
      });
      const { sessions, lifetime } = start(client);
      await settle();

      expect(sessions()).toEqual({
        kind: 'checked',
        notVerified: 1,
        sessions: [
          {
            deviceId: 'PHONE',
            shownId: 'PHONE',
            name: 'Phone',
            verified: false,
          },
          {
            deviceId: 'LAPTOP',
            shownId: 'LAPTOP',
            name: 'Laptop',
            verified: true,
          },
        ],
      });
      lifetime.unsubscribe();
    });

    it('reports a failed list read once opened, and a retry recovers', async () => {
      const client = fakeClient(undefined, true, {
        devices: (_ids, download) =>
          download
            ? Promise.reject(new Error('502'))
            : Promise.resolve(deviceMap(ALICE, [])),
      });
      const { sessions, svc, lifetime } = start(client);
      await settle();

      svc.loadUserSessions(ALICE);
      await settle();
      expect(sessions()).toEqual({ kind: 'failed' });

      client.getUserDeviceInfo.mockResolvedValue(deviceMap(ALICE, [PHONE]));
      svc.loadUserSessions(ALICE);
      expect(sessions()).toEqual({ kind: 'loading' });
      await settle();
      expect(sessions()).toMatchObject({ kind: 'unchecked' });
      lifetime.unsubscribe();
    });

    it('is null without crypto and when no projection is running', async () => {
      const noCrypto = start(fakeClient(undefined, false));
      await settle();
      expect(noCrypto.sessions()).toBeNull();
      noCrypto.svc.loadUserSessions(ALICE);
      await settle();
      expect(noCrypto.sessions()).toBeNull();
      noCrypto.lifetime.unsubscribe();

      TestBed.resetTestingModule();
      const { svc } = setup(fakeClient());
      const detached = svc.userSessions(ALICE);
      await settle();
      expect(detached()).toBeNull();
    });

    it('leaves out dehydrated devices, and names a session by its id when the name is hidden', async () => {
      const client = fakeClient(undefined, true, {
        devices: async () =>
          deviceMap(ALICE, [
            { deviceId: 'HIDDEN' },
            { deviceId: 'BLANK', displayName: '  ' },
            { deviceId: 'DEHYDRATED', displayName: 'Backup', dehydrated: true },
          ]),
      });
      const { sessions, lifetime } = start(client);
      await settle();

      expect(sessions()).toEqual({
        kind: 'unchecked',
        sessions: [
          { deviceId: 'BLANK', shownId: 'BLANK', name: 'BLANK' },
          { deviceId: 'HIDDEN', shownId: 'HIDDEN', name: 'HIDDEN' },
        ],
      });
      expect(client.getDeviceVerificationStatus).not.toHaveBeenCalledWith(
        ALICE,
        'DEHYDRATED',
      );
      lifetime.unsubscribe();
    });

    it('sorts not verified first, then by name, then by id', async () => {
      const verifiedIds = new Set(['A', 'C']);
      const client = fakeClient(async () => status(true, true), true, {
        devices: async () =>
          deviceMap(ALICE, [
            { deviceId: 'C', displayName: 'Same' },
            { deviceId: 'A', displayName: 'Same' },
            { deviceId: 'D', displayName: 'Zed' },
            { deviceId: 'B', displayName: 'Alpha' },
          ]),
        device: async (_userId, deviceId) =>
          deviceStatus(verifiedIds.has(deviceId)),
      });
      const { sessions, lifetime } = start(client);
      await settle();

      expect(sessions()).toMatchObject({
        sessions: [
          { deviceId: 'B' },
          { deviceId: 'D' },
          { deviceId: 'A' },
          { deviceId: 'C' },
        ],
      });
      lifetime.unsubscribe();
    });

    describe('text a session chose for itself', () => {
      const firstSession = async (device: FakeDevice) => {
        const client = fakeClient(undefined, true, {
          devices: async () => deviceMap(ALICE, [device]),
        });
        const { sessions, lifetime } = start(client);
        await settle();
        const first = (sessions() as { sessions: readonly UserSession[] })
          .sessions[0];
        lifetime.unsubscribe();
        return { client, first };
      };

      it.each([
        ['a bidi override', 'evil\u202Egnp.exe', 'evilgnp.exe'],
        ['an isolate', '\u2067Phone\u2069', 'Phone'],
        ['a zero-width space', 'Pho\u200Bne', 'Phone'],
        ['a control character', 'Pho\u0007ne', 'Phone'],
        ['surrounding space', '  Phone  ', 'Phone'],
      ])('removes %s from a name', async (_case, displayName, name) => {
        const { first } = await firstSession({ deviceId: 'ID', displayName });
        expect(first).toMatchObject({ deviceId: 'ID', shownId: 'ID', name });
      });

      it.each([
        ['zero-width characters only', '\u200B\u200D'],
        ['bidi controls only', '\u202E\u202C'],
        ['spaces only', '   '],
      ])(
        'falls back to the id for a name of %s',
        async (_case, displayName) => {
          const { first } = await firstSession({ deviceId: 'ID', displayName });
          expect(first?.name).toBe('ID');
        },
      );

      it('keeps a name that only looks like a state, for the card to show with its id', async () => {
        const { first } = await firstSession({
          deviceId: 'ID',
          displayName: '✓ Verified',
        });
        expect(first).toEqual({
          deviceId: 'ID',
          shownId: 'ID',
          name: '✓ Verified',
        });
      });

      it('shows a changed id escaped, keeps the raw key, and asks the SDK about the raw id', async () => {
        const { client, first } = await firstSession({
          deviceId: 'ID\u202E1',
          displayName: 'Phone',
        });
        expect(first).toEqual({
          deviceId: 'ID\u202E1',
          shownId: 'ID\\u{202E}1',
          name: 'Phone',
        });
        expect(client.getDeviceVerificationStatus).toHaveBeenCalledWith(
          ALICE,
          'ID\u202E1',
        );
      });

      it('shows an id made only of format characters in escaped form, not blank', async () => {
        const { first } = await firstSession({ deviceId: '\u200B' });
        expect(first).toEqual({
          deviceId: '\u200B',
          shownId: '\\u{200B}',
          name: '\\u{200B}',
        });
      });

      it.each([
        ['a leading space', ' ABC', '\\u{20}ABC'],
        ['an inner space', 'A B', 'A\\u{20}B'],
        ['only spaces', '  ', '\\u{20}\\u{20}'],
        ['a backslash', 'A\\B', 'A\\u{5C}B'],
        ['a control character', 'ABC\u0007', 'ABC\\u{7}'],
        ['a variation selector', 'ABC️', 'ABC\\u{FE0F}'],
        ['a combining grapheme joiner', 'ABC͏', 'ABC\\u{34F}'],
        ['a Hangul filler', 'ABCㅤ', 'ABC\\u{3164}'],
        ['a braille blank', 'ABC⠀', 'ABC\\u{2800}'],
        ['a no-break space', 'A B', 'A\\u{A0}B'],
        ['an em space', 'A B', 'A\\u{2003}B'],
        ['Cyrillic lookalikes', 'АВС', '\\u{410}\\u{412}\\u{421}'],
        [
          'a character outside the basic plane',
          'ABC\u{E0041}',
          'ABC\\u{E0041}',
        ],
      ])('spells out %s in an id', async (_case, deviceId, shownId) => {
        const { first } = await firstSession({ deviceId });
        expect(first?.shownId).toBe(shownId);
      });

      it('leaves every printable ASCII character but the backslash as it is', async () => {
        const printable = Array.from({ length: 94 }, (_, i) =>
          String.fromCharCode(0x21 + i),
        )
          .join('')
          .replace('\\', '');
        const { first } = await firstSession({ deviceId: printable });
        expect(first?.shownId).toBe(printable);
      });

      describe('a session cloning another one', () => {
        const read = async (...devices: FakeDevice[]) => {
          const client = fakeClient(undefined, true, {
            devices: async () => deviceMap(ALICE, devices),
          });
          const { sessions, lifetime } = start(client);
          await settle();
          const result = (sessions() as { sessions: readonly UserSession[] })
            .sessions;
          lifetime.unsubscribe();
          return result;
        };

        it('two ids that clean to the same text stay two keys, and read differently', async () => {
          const result = await read(
            { deviceId: 'ABC' },
            { deviceId: 'ABC\u200B' },
          );

          expect(result.map((s) => s.deviceId)).toEqual(['ABC', 'ABC\u200B']);
          expect(result.map((s) => s.shownId)).toEqual(['ABC', 'ABC\\u{200B}']);
        });

        it("a name copying a real id still shows the clone's own id", async () => {
          const result = await read(
            { deviceId: 'ABC' },
            { deviceId: 'ABC\u200B', displayName: 'ABC' },
          );

          expect(result.find((s) => s.deviceId === 'ABC\u200B')).toEqual({
            deviceId: 'ABC\u200B',
            shownId: 'ABC\\u{200B}',
            name: 'ABC',
          });
        });

        it('typing the escaped form out cannot match an escaped id', async () => {
          const result = await read(
            { deviceId: 'ABC​' },
            { deviceId: 'ABC\\u{200B}' },
          );

          const shown = result.map((s) => s.shownId);
          expect(new Set(shown).size).toBe(2);
          expect(shown).toContain('ABC\\u{200B}');
          expect(shown).toContain('ABC\\u{5C}u{200B}');
        });

        it('a code point followed by a digit cannot pass for a longer code point', async () => {
          const result = await read(
            { deviceId: '1' },
            { deviceId: '\u{E0041}' },
          );

          expect(result.map((s) => s.shownId).sort()).toEqual([
            '\\u{E0041}',
            '\\u{E004}1',
          ]);
        });

        it.each([
          ['a Cyrillic lookalike', 'ABC', 'АВС'],
          ['a Hangul filler', 'ABC', 'ABCㅤ'],
          ['a braille blank', 'ABC', 'ABC⠀'],
          ['a variation selector', 'ABC', 'ABC️'],
          ['a no-break space for a space', 'A B', 'A B'],
        ])(
          '%s reads differently from the id it copies',
          async (_c, real, clone) => {
            const result = await read({ deviceId: real }, { deviceId: clone });
            expect(new Set(result.map((s) => s.shownId)).size).toBe(2);
          },
        );
      });
    });

    describe('only an open row uses the network', () => {
      const downloads = (client: ReturnType<typeof fakeClient>) =>
        client.getUserDeviceInfo.mock.calls.filter(([, download]) => download)
          .length;

      it.each([
        [
          'a device update',
          (client: ReturnType<typeof fakeClient>) =>
            devicesHandler(client)([ALICE], false),
        ],
        [
          'a trust change',
          (client: ReturnType<typeof fakeClient>) =>
            trustHandler(client)(ALICE, status(true, true)),
        ],
      ])('a closed row re-reads locally after %s', async (_case, fire) => {
        const client = fakeClient(undefined, true, {
          devices: async () => deviceMap(ALICE, [PHONE]),
        });
        const { svc, lifetime } = start(client);
        await settle();
        svc.loadUserSessions(ALICE);
        await settle();
        expect(downloads(client)).toBe(1);

        svc.closeUserSessions(ALICE);
        fire(client);
        await settle();

        expect(downloads(client)).toBe(1);
        expect(client.getUserDeviceInfo).toHaveBeenLastCalledWith(
          [ALICE],
          false,
        );
        lifetime.unsubscribe();
      });

      it('a closed row re-reads locally when the projection rebuilds', async () => {
        const client = fakeClient(undefined, true, {
          devices: async () => deviceMap(ALICE, [PHONE]),
        });
        const { svc, matrix, lifetime } = start(client);
        await settle();
        svc.loadUserSessions(ALICE);
        await settle();
        svc.closeUserSessions(ALICE);

        const next = fakeClient(undefined, true, {
          devices: async () => deviceMap(ALICE, [PHONE]),
        });
        ngMocks.stubMember(matrix, 'instance', next as unknown as MatrixClient);
        activeUserId.set('@b:hs');
        TestBed.inject(ApplicationRef).tick();
        await settle();

        expect(downloads(next)).toBe(0);
        lifetime.unsubscribe();
      });

      it("a closed row keeps an untracked member's list when the local read is empty", async () => {
        const client = fakeClient(undefined, true, {
          devices: async (_ids, download) =>
            deviceMap(ALICE, download ? [PHONE] : []),
        });
        const { sessions, svc, lifetime } = start(client);
        await settle();
        svc.loadUserSessions(ALICE);
        await settle();

        svc.closeUserSessions(ALICE);
        devicesHandler(client)([ALICE], false);
        await settle();

        expect(sessions()).toMatchObject({ kind: 'unchecked' });
        lifetime.unsubscribe();
      });

      it('a closed row keeps the list when a local re-read fails', async () => {
        const client = fakeClient(undefined, true, {
          devices: async () => deviceMap(ALICE, [PHONE]),
        });
        const { sessions, svc, lifetime } = start(client);
        await settle();
        svc.loadUserSessions(ALICE);
        await settle();
        svc.closeUserSessions(ALICE);

        client.getUserDeviceInfo.mockRejectedValue(new Error('store closed'));
        devicesHandler(client)([ALICE], false);
        await settle();

        expect(sessions()).toMatchObject({ kind: 'unchecked' });
        lifetime.unsubscribe();
      });

      it('opening again reads again, keeping the list on show meanwhile', async () => {
        const client = fakeClient(undefined, true, {
          devices: async () => deviceMap(ALICE, [PHONE]),
        });
        const { sessions, svc, lifetime } = start(client);
        await settle();
        svc.loadUserSessions(ALICE);
        await settle();
        svc.closeUserSessions(ALICE);

        svc.loadUserSessions(ALICE);

        expect(sessions()).toMatchObject({ kind: 'unchecked' });
        await settle();
        expect(downloads(client)).toBe(2);
        lifetime.unsubscribe();
      });
    });

    describe('what the row may claim', () => {
      it("no badges while the member's trust is still unknown", async () => {
        const client = fakeClient(() => new Promise(() => undefined), true, {
          devices: async () => deviceMap(ALICE, [PHONE]),
          device: async () => deviceStatus(true, true),
        });
        const { svc, sessions, lifetime } = start(client);
        await settle();

        expect(svc.userTrust(ALICE)()).toBeNull();
        expect(sessions()).toEqual({
          kind: 'unchecked',
          sessions: [{ deviceId: 'PHONE', shownId: 'PHONE', name: 'Phone' }],
        });
        lifetime.unsubscribe();
      });

      it('a verified member: local trust alone reads as not verified', async () => {
        const client = fakeClient(async () => status(true, true), true, {
          devices: async () => deviceMap(ALICE, [PHONE, LAPTOP]),
          device: async (_userId, deviceId) =>
            deviceId === 'PHONE'
              ? deviceStatus(false, true)
              : deviceStatus(true),
        });
        const { sessions, lifetime } = start(client);
        await settle();

        expect(sessions()).toEqual({
          kind: 'checked',
          notVerified: 1,
          sessions: [
            {
              deviceId: 'PHONE',
              shownId: 'PHONE',
              name: 'Phone',
              verified: false,
            },
            {
              deviceId: 'LAPTOP',
              shownId: 'LAPTOP',
              name: 'Laptop',
              verified: true,
            },
          ],
        });
        lifetime.unsubscribe();
      });

      it.each([
        ['unverified', status(false, false)],
        ['identity-changed', status(false, false, true)],
        ['verified-identity-changed', status(false, true, true)],
      ] as const)(
        'a %s member carries no per-session state, even a stale verified one',
        async (_trust, memberStatus) => {
          const client = fakeClient(async () => memberStatus, true, {
            devices: async () => deviceMap(ALICE, [PHONE]),
            device: async () => deviceStatus(true, true),
          });
          const { sessions, lifetime } = start(client);
          await settle();

          expect(sessions()).toEqual({
            kind: 'unchecked',
            sessions: [{ deviceId: 'PHONE', shownId: 'PHONE', name: 'Phone' }],
          });
          lifetime.unsubscribe();
        },
      );

      it('drops the states as soon as a verified member stops being verified', async () => {
        const reads = deviceStatus(true, true);
        let answer: (value: typeof reads) => void = () => undefined;
        let pending = false;
        const client = fakeClient(async () => status(true, true), true, {
          devices: async () => deviceMap(ALICE, [PHONE]),
          device: () =>
            pending
              ? new Promise((resolve) => (answer = resolve))
              : Promise.resolve(reads),
        });
        const { sessions, lifetime } = start(client);
        await settle();
        expect(sessions()).toMatchObject({ kind: 'checked' });

        pending = true;
        trustHandler(client)(ALICE, status(false, true, true));
        // The list re-read has not answered, and the row has already changed.
        expect(sessions()).toEqual({
          kind: 'unchecked',
          sessions: [{ deviceId: 'PHONE', shownId: 'PHONE', name: 'Phone' }],
        });
        answer(reads);
        await settle();
        lifetime.unsubscribe();
      });
    });

    describe('lifetime', () => {
      it('releases the state with its last holder and drops a late answer', async () => {
        let answer: (devices: ReturnType<typeof deviceMap>) => void = () =>
          undefined;
        const client = fakeClient(undefined, true, {
          devices: () => new Promise((resolve) => (answer = resolve)),
        });
        const { svc, sessions, lifetime } = start(client);
        const first = svc.retainUserSessions(ALICE);
        const second = svc.retainUserSessions(ALICE);

        first();
        expect(svc.userSessions(ALICE)).toBe(sessions);

        second();
        answer(deviceMap(ALICE, [PHONE]));
        await settle();
        expect(sessions()).toEqual({ kind: 'unknown' });
        expect(svc.userSessions(ALICE)).not.toBe(sessions);
        lifetime.unsubscribe();
      });

      it('stops re-reading a released user', async () => {
        const client = fakeClient();
        const { svc, lifetime } = start(client);
        const release = svc.retainUserSessions(ALICE);
        await settle();
        release();
        const reads = client.getUserDeviceInfo.mock.calls.length;

        devicesHandler(client)([ALICE], false);
        trustHandler(client)(ALICE, status(true, true));
        await settle();

        expect(client.getUserDeviceInfo).toHaveBeenCalledTimes(reads);
        lifetime.unsubscribe();
      });

      it("resets on an account switch and drops the old account's late answer", async () => {
        let answer: (devices: ReturnType<typeof deviceMap>) => void = () =>
          undefined;
        const clientA = fakeClient(undefined, true, {
          devices: () => new Promise((resolve) => (answer = resolve)),
        });
        const { sessions, matrix, lifetime } = start(clientA);

        const clientB = fakeClient(undefined, true, {
          devices: async () => deviceMap(ALICE, [LAPTOP]),
        });
        ngMocks.stubMember(
          matrix,
          'instance',
          clientB as unknown as MatrixClient,
        );
        activeUserId.set('@b:hs');
        TestBed.inject(ApplicationRef).tick();
        await settle();
        answer(deviceMap(ALICE, [PHONE]));
        await settle();

        expect(sessions()).toMatchObject({
          sessions: [{ deviceId: 'LAPTOP' }],
        });
        lifetime.unsubscribe();
      });

      it('stops listening once the projection is released', () => {
        const client = fakeClient();
        const { lifetime } = start(client);
        const handler = devicesHandler(client);

        lifetime.unsubscribe();

        expect(client.off).toHaveBeenCalledWith(
          CryptoEvent.DevicesUpdated,
          handler,
        );
      });

      it('drops a late answer once the projection is released', async () => {
        let answer: (devices: ReturnType<typeof deviceMap>) => void = () =>
          undefined;
        const client = fakeClient(undefined, true, {
          devices: () => new Promise((resolve) => (answer = resolve)),
        });
        const { sessions, lifetime } = start(client);

        lifetime.unsubscribe();
        answer(deviceMap(ALICE, [PHONE]));
        await settle();

        expect(sessions()).toBeNull();
      });

      it('is null once the projection is released', async () => {
        const client = fakeClient(undefined, true, {
          devices: async () => deviceMap(ALICE, [PHONE]),
        });
        const { sessions, lifetime } = start(client);
        await settle();
        expect(sessions()).not.toBeNull();

        lifetime.unsubscribe();
        expect(sessions()).toBeNull();
      });
    });
  });

  describe('identity actions', () => {
    it.each([
      ['acknowledgeIdentity', 'pinCurrentUserIdentity'],
      ['withdrawVerification', 'withdrawVerificationRequirement'],
    ] as const)(
      '%s calls %s and re-reads the user',
      async (action, sdkMethod) => {
        let next = status(false, true, true);
        const client = fakeClient(async () => next);
        const { svc } = setup(client);
        const lifetime = svc.runProjection().subscribe();
        const trust = svc.userTrust(ALICE);
        await settle();
        expect(trust()).toBe('verified-identity-changed');

        next = status(false, false);
        await firstValueFrom(svc[action](ALICE), { defaultValue: undefined });
        await settle();

        expect(client[sdkMethod]).toHaveBeenCalledWith(ALICE);
        expect(trust()).toBe('unverified');
        lifetime.unsubscribe();
      },
    );

    it('is cold: nothing runs until subscribed', () => {
      const client = fakeClient();
      const { svc } = setup(client);

      svc.acknowledgeIdentity(ALICE);

      expect(client.pinCurrentUserIdentity).not.toHaveBeenCalled();
    });

    it('reports a failure as a TrustOperationError', async () => {
      const client = fakeClient();
      client.withdrawVerificationRequirement.mockRejectedValue(
        new Error('no identity for @alice:hs'),
      );
      const { svc } = setup(client);

      const error = await firstValueFrom(svc.withdrawVerification(ALICE)).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(TrustOperationError);
      expect((error as TrustOperationError).operation).toBe(
        'withdraw-verification',
      );
      expect((error as Error).message).not.toContain('@alice:hs');
    });
  });
});
