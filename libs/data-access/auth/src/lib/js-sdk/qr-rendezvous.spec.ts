import { TestBed } from '@angular/core/testing';
import { firstValueFrom, type Observable, type Subscription } from 'rxjs';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('matrix-js-sdk', async (importActual) => {
  const actual = await importActual<typeof import('matrix-js-sdk')>();
  return { ...actual, createClient: vi.fn() };
});

import {
  Ecies,
  QrCodeData,
  QrCodeIntent,
  initAsync,
  type Curve25519PublicKey,
} from '@matrix-org/matrix-sdk-crypto-wasm';
import { createClient, type MatrixClient } from 'matrix-js-sdk';
import {
  ClientRendezvousFailureReason,
  MSC4108FailureReason,
  RendezvousError,
} from 'matrix-js-sdk/lib/rendezvous';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { assertPlainData } from '@trinity/util/matrix';
import type { QrLinkUpdate, QrSignInUpdate } from '../auth-engine';
import { AUTH_METADATA } from '../auth-metadata.fixture';
import { qrSignInFailureOf } from '../qr-sign-in/qr-sign-in.model';
import {
  JsSdkQrRendezvous,
  QrRendezvousFactory,
  type QrRendezvousFlow,
} from './qr-rendezvous';

type Step =
  | 'generateCode'
  | 'negotiateProtocols'
  | 'deviceAuthorizationGrant'
  | 'completeLoginOnNewDevice'
  | 'shareSecrets';
type Pause = 'server-reported' | 'client-rejected' | 'signed-in';

const BASE = 'https://hs';
const ACCOUNT = '@new:hs';
const metadata = AUTH_METADATA;
const tokens = {
  access_token: 'at',
  token_type: 'Bearer',
  refresh_token: 'rt',
  expires_in: 300,
};
const secrets = { cross_signing: { master_key: 'MASTER-SECRET' } };
const existingClient = {
  id: 'existing-client',
  getUserId: () => '@me:hs',
  getAuthMetadata: vi.fn(async () => ({ issuer: 'https://auth/' })),
} as unknown as MatrixClient;

/** A fake MSC4108SignInWithQR whose steps resolve unless told to hang or fail. */
class FakeFlow {
  readonly calls: string[] = [];
  readonly hang = new Set<Step>();
  readonly failures = new Map<Step, unknown>();
  readonly code = new Uint8Array([1, 2, 3]);
  readonly checkCode = '42';

  constructor(
    private readonly onFailure: (reason: string) => void,
    private readonly isNewDevice: boolean,
  ) {}

  generateCode = vi.fn(() => this.step('generateCode', undefined));
  negotiateProtocols = vi.fn(() =>
    this.step('negotiateProtocols', { serverName: 'hs' }),
  );
  deviceAuthorizationGrant = vi.fn(() =>
    this.step(
      'deviceAuthorizationGrant',
      this.isNewDevice
        ? { verificationUri: 'https://auth/link', userCode: 'ABCD' }
        : { verificationUri: 'https://auth/link?code=ABCD' },
    ),
  );
  completeLoginOnNewDevice = vi.fn(() =>
    this.step('completeLoginOnNewDevice', tokens),
  );
  shareSecrets = vi.fn(() => this.step('shareSecrets', { secrets }));
  // Like the SDK's channel, a cancel reports its reason through onFailure.
  cancel = vi.fn(async (reason: string) => {
    this.calls.push(`cancel:${reason}`);
    this.onFailure(reason);
  });
  close = vi.fn(async () => {
    this.calls.push('close');
  });
  declineLoginOnExistingDevice = vi.fn(async () => {
    this.calls.push('decline');
  });

  private readonly held = new Map<Step, () => void>();

  /** Fails the session from outside a step, as the SDK's expiry timer does. */
  failSession(reason: string): void {
    this.onFailure(reason);
  }

  /** Lets a hung step resolve. */
  release(name: Step): void {
    this.held.get(name)?.();
  }

  private step<T>(name: Step, value: T): Promise<T> {
    this.calls.push(name);
    if (this.hang.has(name)) {
      return new Promise<T>((resolve) =>
        this.held.set(name, () => resolve(value)),
      );
    }
    if (this.failures.has(name)) {
      return Promise.reject(this.failures.get(name));
    }
    return Promise.resolve(value);
  }
}

const crypto = {
  importSecretsBundle: vi.fn(),
  crossSignDevice: vi.fn(),
  checkKeyBackupAndEnable: vi.fn(),
  isCrossSigningReady: vi.fn(),
  getDeviceVerificationStatus: vi.fn(),
};
const whoami = vi.fn();

function setup(configure: (flow: FakeFlow) => void = () => undefined) {
  const flows: FakeFlow[] = [];
  const build = (onFailure: (reason: string) => void, isNewDevice: boolean) => {
    const flow = new FakeFlow(onFailure, isNewDevice);
    configure(flow);
    flows.push(flow);
    return flow as unknown as QrRendezvousFlow;
  };
  const factory = {
    newDevice: vi.fn(
      async (_url: string, onFailure: (reason: string) => void) => ({
        flow: build(onFailure, true),
        expires: null as string | null,
      }),
    ),
    existingDevice: vi.fn(
      async (
        _client: MatrixClient,
        qr: string,
        onFailure: (reason: string) => void,
      ) => (qr ? build(onFailure, false) : null),
    ),
  };
  const newClient = {
    getCrypto: () => crypto,
    getDeviceId: () => 'QRDEV',
    getUserId: () => ACCOUNT,
  };
  const clients = new Map<string, unknown>([
    ['@me:hs', existingClient],
    [ACCOUNT, newClient],
  ]);
  TestBed.configureTestingModule({
    providers: [
      { provide: QrRendezvousFactory, useValue: factory },
      {
        provide: JS_SDK_CLIENTS,
        useValue: {
          clientFor: (id: string) => clients.get(id) ?? null,
          holderFor: () => null,
        },
      },
    ],
  });
  return {
    flows,
    factory,
    clients,
    qr: TestBed.inject(JsSdkQrRendezvous),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

function record<T extends { kind: string }>(
  updates$: Observable<T>,
  onUpdate: (update: T) => void = () => undefined,
) {
  const states: T[] = [];
  let completed = false;
  const subscription: Subscription = updates$.subscribe({
    next: (state) => {
      states.push(state);
      onUpdate(state);
    },
    complete: () => (completed = true),
  });
  return {
    states,
    kinds: () => states.map((state) => state.kind),
    completed: () => completed,
    subscription,
  };
}

/** Shows a code and answers every pause as TypeScript does, retrying a refused client once. */
function signIn(
  qr: JsSdkQrRendezvous,
  options: { skip?: readonly Pause[]; retryWith?: string } = {},
) {
  let retried = false;
  return record(
    qr.signInWithQr(BASE, { grantMetadata: metadata, clientId: 'client-id' }),
    (update: QrSignInUpdate) => {
      if (options.skip?.includes(update.kind as Pause)) return;
      if (update.kind === 'server-reported') {
        qr.answerQrSignIn(update.flowId, {
          kind: 'server-accepted',
        }).subscribe();
      } else if (update.kind === 'client-rejected' && !retried) {
        retried = true;
        qr.answerQrSignIn(update.flowId, {
          kind: 'retry-grant',
          clientId: options.retryWith ?? 'fresh-id',
        }).subscribe();
      } else if (update.kind === 'signed-in') {
        qr.continueQrSignIn(update.flowId, ACCOUNT).subscribe();
      }
    },
  );
}

/** Starts a link and remembers the paused flow, so the test can answer it. */
function link(qr: JsSdkQrRendezvous, code = 'CQ==', accountId = '@me:hs') {
  let flowId = '';
  const run = record(qr.linkDeviceWithQr(accountId, code), (update) => {
    if (update.kind === 'confirm-check-code') flowId = update.flowId;
  });
  return {
    ...run,
    confirm: (match: boolean, identityHeld = true) =>
      firstValueFrom(qr.confirmQrLink(flowId, { match, identityHeld })),
  };
}

const sdkReasons = [
  ...Object.values(MSC4108FailureReason),
  ...Object.values(ClientRendezvousFailureReason),
];

beforeEach(() => {
  crypto.importSecretsBundle.mockReset().mockResolvedValue(undefined);
  crypto.crossSignDevice.mockReset().mockResolvedValue(undefined);
  crypto.checkKeyBackupAndEnable.mockReset().mockResolvedValue(null);
  crypto.isCrossSigningReady.mockReset().mockResolvedValue(true);
  crypto.getDeviceVerificationStatus
    .mockReset()
    .mockResolvedValue({ crossSigningVerified: true });
  whoami
    .mockReset()
    .mockResolvedValue({ user_id: ACCOUNT, device_id: 'QRDEV' });
  vi.mocked(createClient)
    .mockReset()
    .mockReturnValue({ whoami } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('JsSdkQrRendezvous.signInWithQr', () => {
  it('shows a code, pauses for TypeScript, signs in and imports the secrets', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const { qr, flows } = setup();
    const run = signIn(qr);
    await settle();

    const flowId = expect.any(String);
    expect(run.states).toEqual<QrSignInUpdate[]>([
      { kind: 'showing-code', qr: 'AQID', expiresAt: 61_000 },
      { kind: 'server-reported', flowId, serverName: 'hs' },
      { kind: 'confirm-check-code', code: '42' },
      { kind: 'waiting-for-approval', userCode: 'ABCD' },
      {
        kind: 'signing-in',
        tokens: {
          accessToken: 'at',
          refreshToken: 'rt',
          accessTokenExpiresAt: 301_000,
        },
      },
      { kind: 'signed-in', flowId, userId: ACCOUNT, deviceId: 'QRDEV' },
      { kind: 'done', verified: true },
    ]);
    run.states.forEach((update) => assertPlainData(update));
    expect(run.completed()).toBe(true);
    const flow = flows[0];
    expect(flow.deviceAuthorizationGrant).toHaveBeenCalledWith({
      metadata,
      clientId: 'client-id',
      deviceId: expect.stringMatching(/^[A-Za-z0-9]{10}$/),
    });
    expect(flow.deviceAuthorizationGrant).toHaveBeenCalledTimes(1);
    expect(flow.completeLoginOnNewDevice).toHaveBeenCalledWith({
      clientId: 'client-id',
    });
    // The account is confirmed with the new token before TypeScript establishes it.
    expect(createClient).toHaveBeenCalledWith({
      baseUrl: BASE,
      accessToken: 'at',
    });
    expect(crypto.importSecretsBundle).toHaveBeenCalledWith(secrets);
    expect(flow.cancel).not.toHaveBeenCalled();
    expect(flow.close).toHaveBeenCalled();
  });

  it('asks for no grant until TypeScript accepts the reported server', async () => {
    const { qr, flows } = setup();
    const run = signIn(qr, { skip: ['server-reported'] });
    await settle();

    expect(run.kinds().at(-1)).toBe('server-reported');
    expect(flows[0].deviceAuthorizationGrant).not.toHaveBeenCalled();

    const paused = run.states.at(-1) as { flowId: string };
    await firstValueFrom(
      qr.answerQrSignIn(paused.flowId, { kind: 'server-accepted' }),
    );
    await settle();
    expect(run.kinds()).toContain('confirm-check-code');
    expect(flows[0].deviceAuthorizationGrant).toHaveBeenCalled();
  });

  it('shares no secrets until TypeScript has established the session', async () => {
    const { qr, flows } = setup();
    const run = signIn(qr, { skip: ['signed-in'] });
    await settle();

    expect(run.kinds().at(-1)).toBe('signed-in');
    expect(flows[0].shareSecrets).not.toHaveBeenCalled();

    const paused = run.states.at(-1) as { flowId: string };
    await firstValueFrom(qr.continueQrSignIn(paused.flowId, ACCOUNT));
    await settle();
    expect(flows[0].shareSecrets).toHaveBeenCalled();
    expect(run.states.at(-1)).toEqual({ kind: 'done', verified: true });
  });

  describe('a client id the provider rejects', () => {
    // What the SDK throws when the device endpoint answers with an OAuth error.
    const rejected = () => new Error('Invalid device authorization response');

    it('pauses, then retries the grant on the same flow with the client TypeScript names', async () => {
      const { qr, flows } = setup((flow) =>
        flow.deviceAuthorizationGrant.mockRejectedValueOnce(rejected()),
      );
      const run = signIn(qr);
      await settle();

      expect(run.kinds()).toContain('client-rejected');
      expect(run.states.at(-1)).toEqual({ kind: 'done', verified: true });
      const grants = flows[0].deviceAuthorizationGrant.mock
        .calls as unknown[][];
      expect(
        grants.map((call) => (call[0] as { clientId: string }).clientId),
      ).toEqual(['client-id', 'fresh-id']);
      expect(flows[0].completeLoginOnNewDevice).toHaveBeenCalledWith({
        clientId: 'fresh-id',
      });
      expect(flows).toHaveLength(1);
    });

    it('pauses again when the new client is refused too', async () => {
      const { qr } = setup((flow) =>
        flow.failures.set('deviceAuthorizationGrant', rejected()),
      );
      const run = signIn(qr);
      await settle();

      expect(run.kinds().filter((kind) => kind === 'client-rejected')).toEqual([
        'client-rejected',
        'client-rejected',
      ]);
      expect(run.completed()).toBe(false);
    });

    it.each([
      ['the channel closes', new Error('Channel closed'), 'unknown'],
      ['the network fails', new TypeError('Failed to fetch'), 'network'],
    ])('does not pause when %s', async (_name, error, reason) => {
      const { qr, flows } = setup((flow) =>
        flow.failures.set('deviceAuthorizationGrant', error),
      );
      const run = signIn(qr);
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'failed', reason });
      expect(run.kinds()).not.toContain('client-rejected');
      expect(flows[0].deviceAuthorizationGrant).toHaveBeenCalledTimes(1);
    });
  });

  describe('confirming the account with the new token', () => {
    it('fails, before the session is handed over, when the provider names no device', async () => {
      whoami.mockResolvedValue({ user_id: ACCOUNT });
      const { qr, flows } = setup();
      const run = signIn(qr);
      await settle();

      expect(run.kinds().slice(-2)).toEqual(['signing-in', 'failed']);
      expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'unknown' });
      expect(flows[0].shareSecrets).not.toHaveBeenCalled();
    });

    it('reports a network failure', async () => {
      whoami.mockRejectedValue(new TypeError('Failed to fetch'));
      const { qr } = setup();
      const run = signIn(qr);
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'network' });
    });
  });

  it('shows the expiry the server sent for the session', async () => {
    const now = Date.parse('2026-10-19T12:00:00Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { qr, factory } = setup((flow) =>
      flow.hang.add('negotiateProtocols'),
    );
    const created = factory.newDevice.getMockImplementation()!;
    factory.newDevice.mockImplementation(async (url, onFailure) => ({
      ...(await created(url, onFailure)),
      expires: new Date(now + 10 * 60_000).toUTCString(),
    }));
    const run = signIn(qr);
    await settle();

    expect(run.states.at(-1)).toEqual(
      expect.objectContaining({
        kind: 'showing-code',
        expiresAt: now + 10 * 60_000,
      }),
    );
  });

  it('falls back to a one-minute expiry when the Expires header cannot be read', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const { qr, factory } = setup((flow) =>
      flow.hang.add('negotiateProtocols'),
    );
    const created = factory.newDevice.getMockImplementation()!;
    factory.newDevice.mockImplementation(async (url, onFailure) => ({
      ...(await created(url, onFailure)),
      expires: 'not a date',
    }));
    const run = signIn(qr);
    await settle();

    expect(run.states.at(-1)).toEqual(
      expect.objectContaining({ kind: 'showing-code', expiresAt: 61_000 }),
    );
  });

  describe('a failure after the session is established', () => {
    it('ends done but unverified when sharing the secrets fails', async () => {
      const { qr, flows } = setup((flow) =>
        flow.failures.set(
          'shareSecrets',
          new RendezvousError('failed', MSC4108FailureReason.UserCancelled),
        ),
      );
      const run = signIn(qr);
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'done', verified: false });
      expect(run.kinds()).not.toContain('failed');
      expect(run.completed()).toBe(true);
      expect(flows[0].cancel).not.toHaveBeenCalled();
    });

    it('ends done but unverified when the other device cancels while secrets are shared', async () => {
      const { qr, flows } = setup((flow) => flow.hang.add('shareSecrets'));
      const run = signIn(qr);
      await settle();

      flows[0].failSession(MSC4108FailureReason.UserCancelled);
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'done', verified: false });
      expect(run.kinds()).not.toContain('failed');
    });

    it('ends unverified when no secrets arrive', async () => {
      const { qr } = setup((flow) =>
        flow.shareSecrets.mockResolvedValue({} as never),
      );
      const run = signIn(qr);
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'done', verified: false });
      expect(crypto.importSecretsBundle).not.toHaveBeenCalled();
    });

    it('ends unverified when the account is not live to import into', async () => {
      const { qr, clients } = setup();
      clients.delete(ACCOUNT);
      const run = signIn(qr);
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'done', verified: false });
      expect(crypto.importSecretsBundle).not.toHaveBeenCalled();
    });

    it('imports nothing when continued as another live account', async () => {
      const { qr, flows, clients } = setup();
      clients.set('@other:hs', {
        getCrypto: () => crypto,
        getDeviceId: () => 'OTHERDEV',
        getUserId: () => '@other:hs',
      });
      const run = record(
        qr.signInWithQr(BASE, {
          grantMetadata: metadata,
          clientId: 'client-id',
        }),
        (update) => {
          if (update.kind === 'server-reported') {
            qr.answerQrSignIn(update.flowId, {
              kind: 'server-accepted',
            }).subscribe();
          } else if (update.kind === 'signed-in') {
            qr.continueQrSignIn(update.flowId, '@other:hs').subscribe();
          }
        },
      );
      await settle();

      expect(flows[0].shareSecrets).toHaveBeenCalled();
      expect(run.states.at(-1)).toEqual({ kind: 'done', verified: false });
      expect(crypto.importSecretsBundle).not.toHaveBeenCalled();
      expect(crypto.crossSignDevice).not.toHaveBeenCalled();
    });

    it('imports nothing when the account now runs on another device', async () => {
      const { qr, clients } = setup();
      clients.set(ACCOUNT, {
        getCrypto: () => crypto,
        getDeviceId: () => 'NEWER',
        getUserId: () => ACCOUNT,
      });
      const run = signIn(qr);
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'done', verified: false });
      expect(crypto.importSecretsBundle).not.toHaveBeenCalled();
      expect(crypto.crossSignDevice).not.toHaveBeenCalled();
    });

    it('still fails while TypeScript establishes the session', async () => {
      const { qr, flows } = setup();
      const run = signIn(qr, { skip: ['signed-in'] });
      await settle();

      flows[0].failSession(MSC4108FailureReason.UserCancelled);
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'declined' });
    });
  });

  describe('importing the shared secrets', () => {
    async function verified(): Promise<boolean> {
      const { qr } = setup();
      const run = signIn(qr);
      await settle();
      const done = run.states.at(-1);
      if (done?.kind !== 'done') throw new Error(`ended ${done?.kind}`);
      return done.verified;
    }

    it('imports the bundle, cross-signs this device and enables backup, in that order', async () => {
      expect(await verified()).toBe(true);

      expect(crypto.importSecretsBundle).toHaveBeenCalledWith(secrets);
      expect(crypto.crossSignDevice).toHaveBeenCalledWith('QRDEV');
      const order = [
        crypto.importSecretsBundle,
        crypto.crossSignDevice,
        crypto.checkKeyBackupAndEnable,
      ].map((step) => step.mock.invocationCallOrder[0]);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('reports an unverified device, cross-signs nothing and logs no secret when the import fails', async () => {
      const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
        (level) => vi.spyOn(console, level).mockImplementation(() => undefined),
      );
      crypto.importSecretsBundle.mockRejectedValue(
        new Error('bad bundle MASTER-SECRET'),
      );

      expect(await verified()).toBe(false);

      expect(crypto.crossSignDevice).not.toHaveBeenCalled();
      expect(JSON.stringify(logged.map((spy) => spy.mock.calls))).not.toMatch(
        /SECRET/,
      );
    });

    it('reports a verified device when only enabling backup fails', async () => {
      crypto.checkKeyBackupAndEnable.mockRejectedValue(new Error('no backup'));

      expect(await verified()).toBe(true);
    });

    it('reports an unverified device when it is not cross-signing verified after the import', async () => {
      crypto.getDeviceVerificationStatus.mockResolvedValue({
        crossSigningVerified: false,
      });

      expect(await verified()).toBe(false);
      expect(crypto.getDeviceVerificationStatus).toHaveBeenCalledWith(
        ACCOUNT,
        'QRDEV',
      );
    });

    it('reports an unverified device when cross-signing is not ready after the import', async () => {
      crypto.isCrossSigningReady.mockResolvedValue(false);

      expect(await verified()).toBe(false);
    });

    it('reports an unverified device when cross-signing fails', async () => {
      crypto.crossSignDevice.mockRejectedValue(new Error('upload failed'));

      expect(await verified()).toBe(false);
    });
  });

  it('is cold', async () => {
    const { qr, factory } = setup();
    qr.signInWithQr(BASE, { grantMetadata: metadata, clientId: 'client-id' });
    await settle();
    expect(factory.newDevice).not.toHaveBeenCalled();
  });

  it.each<[QrSignInUpdate['kind'], Step | null, Pause[]]>([
    ['showing-code', 'negotiateProtocols', []],
    ['server-reported', null, ['server-reported']],
    ['confirm-check-code', 'deviceAuthorizationGrant', []],
    ['waiting-for-approval', 'completeLoginOnNewDevice', []],
    ['signed-in', null, ['signed-in']],
    ['signed-in', 'shareSecrets', []],
  ])(
    'unsubscribing at %s (%s) cancels and closes',
    async (kind, hung, skip) => {
      const { qr, flows } = setup((flow) => hung && flow.hang.add(hung));
      const run = signIn(qr, { skip });
      await settle();
      expect(run.states.at(-1)?.kind).toBe(kind);

      run.subscription.unsubscribe();
      await settle();
      expect(flows[0].calls.slice(-2)).toEqual([
        'cancel:user_cancelled',
        'close',
      ]);
    },
  );

  it('cancels a flow that is still being created when unsubscribed', async () => {
    const { qr, factory, flows } = setup();
    let release!: () => void;
    const created = factory.newDevice.getMockImplementation()!;
    factory.newDevice.mockImplementation(async (url, onFailure) => {
      await new Promise<void>((resolve) => (release = resolve));
      return created(url, onFailure);
    });
    const run = signIn(qr);
    await settle();
    run.subscription.unsubscribe();
    release();
    await settle();
    expect(flows[0].calls).toEqual(['cancel:user_cancelled', 'close']);
  });

  it.each(sdkReasons)('maps an SDK rejection with %s', async (reason) => {
    const { qr } = setup((flow) =>
      flow.failures.set(
        'negotiateProtocols',
        new RendezvousError('failed', reason),
      ),
    );
    const run = signIn(qr);
    await settle();
    expect(run.states.at(-1)).toEqual({
      kind: 'failed',
      reason: qrSignInFailureOf(reason),
    });
    expect(run.completed()).toBe(true);
  });

  it('reports a network failure', async () => {
    const { qr } = setup((flow) =>
      flow.failures.set('generateCode', new TypeError('Failed to fetch')),
    );
    const run = signIn(qr);
    await settle();
    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'network' });
  });

  it('fails expired when the session expires, and a new subscription shows a new code', async () => {
    const { qr, flows, factory } = setup((flow) =>
      flow.hang.add('negotiateProtocols'),
    );
    const first = signIn(qr);
    await settle();
    expect(first.states.at(-1)?.kind).toBe('showing-code');

    flows[0].failSession(ClientRendezvousFailureReason.Expired);
    await settle();
    expect(first.states.at(-1)).toEqual({ kind: 'failed', reason: 'expired' });
    expect(first.completed()).toBe(true);

    const second = signIn(qr);
    await settle();
    expect(factory.newDevice).toHaveBeenCalledTimes(2);
    expect(flows[1].generateCode).toHaveBeenCalled();
    expect(second.states.at(-1)?.kind).toBe('showing-code');
  });

  it('ends declined when the existing device declines', async () => {
    // The SDK throws this when it receives the existing device's m.login.failure.
    const { qr } = setup((flow) =>
      flow.failures.set(
        'completeLoginOnNewDevice',
        new RendezvousError('Failed', MSC4108FailureReason.UserCancelled),
      ),
    );
    const run = signIn(qr);
    await settle();
    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'declined' });
  });

  it('reports a server without a rendezvous endpoint as unsupported', async () => {
    const { qr, factory } = setup();
    factory.newDevice.mockRejectedValue(new Error('Invalid rendezvous URI'));
    const run = signIn(qr);
    await settle();
    expect(run.states).toEqual([{ kind: 'failed', reason: 'unsupported' }]);
  });

  it('fails when the session reports a 404 while opening', async () => {
    // The SDK's send resolves on a 404 and reports it only through onFailure.
    const { qr, factory, flows } = setup();
    const created = factory.newDevice.getMockImplementation()!;
    factory.newDevice.mockImplementation(async (url, onFailure) => {
      const result = await created(url, onFailure);
      onFailure(ClientRendezvousFailureReason.Unknown);
      return result;
    });
    const run = signIn(qr);
    await settle();
    expect(run.states).toEqual([{ kind: 'failed', reason: 'unknown' }]);
    expect(flows[0].calls).toEqual(['close']);
  });

  it('reports the first failure only', async () => {
    const { qr, flows } = setup((flow) => flow.hang.add('negotiateProtocols'));
    const run = signIn(qr);
    await settle();
    flows[0].failSession(ClientRendezvousFailureReason.Expired);
    flows[0].failSession(ClientRendezvousFailureReason.Unknown);
    await settle();
    expect(run.kinds().filter((kind) => kind === 'failed')).toHaveLength(1);
  });

  describe('answers', () => {
    const gone = {
      ok: false,
      failure: expect.objectContaining({ code: 'qr-flow-gone' }),
    };

    it('refuses an answer the flow is not paused for, and counts the right one once', async () => {
      const { qr } = setup();
      const run = signIn(qr, { skip: ['server-reported'] });
      await settle();
      const { flowId } = run.states.at(-1) as { flowId: string };

      await expect(
        firstValueFrom(qr.continueQrSignIn(flowId, ACCOUNT)),
      ).resolves.toEqual(gone);
      await expect(
        firstValueFrom(
          qr.answerQrSignIn(flowId, { kind: 'retry-grant', clientId: 'x' }),
        ),
      ).resolves.toEqual(gone);
      await expect(
        firstValueFrom(qr.answerQrSignIn(flowId, { kind: 'server-accepted' })),
      ).resolves.toEqual({ ok: true, value: null });
      await expect(
        firstValueFrom(qr.answerQrSignIn(flowId, { kind: 'server-accepted' })),
      ).resolves.toEqual(gone);
    });

    it('refuses an answer for a flow that ended', async () => {
      const { qr } = setup();
      const run = signIn(qr, { skip: ['server-reported'] });
      await settle();
      const { flowId } = run.states.at(-1) as { flowId: string };
      run.subscription.unsubscribe();

      await expect(
        firstValueFrom(qr.answerQrSignIn(flowId, { kind: 'server-accepted' })),
      ).resolves.toEqual(gone);
    });
  });
});

describe('QrRendezvousFactory.existingDevice', () => {
  const RENDEZVOUS = 'https://rendezvous.example/abc';
  const base64 = (code: QrCodeData) =>
    btoa(String.fromCharCode(...code.toBytes()));
  const read = (qr: string) =>
    new QrRendezvousFactory().existingDevice(
      existingClient,
      qr,
      () => undefined,
    );
  // Building a code consumes its key, so each code gets its own.
  const key = (): Curve25519PublicKey => new Ecies().public_key();

  beforeAll(() => initAsync());

  it('opens a flow for a code a new device shows for MSC4108', async () => {
    await expect(
      read(base64(new QrCodeData(key(), RENDEZVOUS))),
    ).resolves.not.toBeNull();
  });

  it.each([
    [
      'an MSC4388 code, which has no rendezvous URL',
      () =>
        base64(
          QrCodeData.newMsc4388(
            key(),
            'rendezvous-id',
            'https://hs.example',
            QrCodeIntent.Login,
          ),
        ),
    ],
    [
      'a code an existing device shows',
      () => base64(new QrCodeData(key(), RENDEZVOUS, 'hs.example')),
    ],
    ['bytes that are no QR login code', () => btoa('not a sign-in code')],
    ['text that is not base64', () => '%%%'],
  ])('refuses %s', async (_name, code) => {
    await expect(read(code())).resolves.toBeNull();
  });
});

describe('JsSdkQrRendezvous.linkDeviceWithQr', () => {
  it('connects, pauses at the check code, then approves and shares the secrets', async () => {
    const { qr, flows, factory } = setup();
    const run = link(qr);
    await settle();
    expect(run.kinds()).toEqual(['connecting', 'confirm-check-code']);

    await expect(run.confirm(true)).resolves.toEqual({ ok: true, value: null });
    await settle();
    expect(run.states).toEqual<QrLinkUpdate[]>([
      { kind: 'connecting' },
      { kind: 'confirm-check-code', flowId: expect.any(String), code: '42' },
      {
        kind: 'approve-in-browser',
        verificationUri: 'https://auth/link?code=ABCD',
      },
      { kind: 'sharing-secrets' },
      { kind: 'done' },
    ]);
    run.states.forEach((update) => assertPlainData(update));
    expect(run.completed()).toBe(true);
    expect(factory.existingDevice).toHaveBeenCalledWith(
      existingClient,
      'CQ==',
      expect.any(Function),
    );
    expect(flows[0].deviceAuthorizationGrant).toHaveBeenCalledWith();
    expect(flows[0].cancel).not.toHaveBeenCalled();
    // The new device reads the secrets after this, so the session stays for it to delete.
    expect(flows[0].close).not.toHaveBeenCalled();
  });

  it('never shares secrets before the check code is confirmed', async () => {
    const { qr, flows } = setup();
    const run = link(qr);
    await settle();
    await settle();
    expect(flows[0].shareSecrets).not.toHaveBeenCalled();
    expect(flows[0].deviceAuthorizationGrant).not.toHaveBeenCalled();

    await run.confirm(true);
    await settle();
    expect(flows[0].shareSecrets).toHaveBeenCalled();
  });

  it('cancels as insecure when the check codes differ, and does nothing else', async () => {
    const { qr, flows } = setup();
    const run = link(qr);
    await settle();

    await run.confirm(false, false);
    await settle();
    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'insecure' });
    expect(run.completed()).toBe(true);
    // The decline goes first, so the new device learns why the link ended.
    expect(flows[0].calls).toEqual([
      'negotiateProtocols',
      'decline',
      'cancel:insecure_channel_detected',
    ]);
    expect(flows[0].deviceAuthorizationGrant).not.toHaveBeenCalled();
    expect(flows[0].shareSecrets).not.toHaveBeenCalled();
  });

  it('refuses, before any grant or secret, a device that does not hold the published identity', async () => {
    const { qr, flows } = setup();
    const run = link(qr);
    await settle();

    await run.confirm(true, false);
    await settle();

    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'unknown' });
    expect(flows[0].deviceAuthorizationGrant).not.toHaveBeenCalled();
    expect(flows[0].shareSecrets).not.toHaveBeenCalled();
    // The new device is told the link ended.
    expect(flows[0].calls.slice(-2)).toEqual([
      'decline',
      'cancel:user_cancelled',
    ]);
  });

  it.each([
    ['another origin', 'https://other.example/link?code=ABCD'],
    ['a look-alike host', 'https://auth.other.example/link'],
    ['an unparseable link', 'not a url'],
  ])(
    'fails insecure and never shows an approval link on %s',
    async (_name, verificationUri) => {
      const { qr, flows } = setup((flow) =>
        flow.deviceAuthorizationGrant.mockResolvedValue({
          verificationUri,
        } as never),
      );
      const run = link(qr);
      await settle();

      await run.confirm(true);
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'insecure' });
      expect(run.kinds()).not.toContain('approve-in-browser');
      expect(JSON.stringify(run.states)).not.toContain(verificationUri);
      expect(flows[0].shareSecrets).not.toHaveBeenCalled();
      expect(flows[0].calls.at(-1)).toBe('cancel:user_cancelled');
    },
  );

  it('accepts an approval link on the device-authorization endpoint origin', async () => {
    const { qr, clients } = setup();
    clients.set('@other:hs', {
      getUserId: () => '@other:hs',
      getAuthMetadata: vi.fn(async () => ({
        issuer: 'https://id.example/',
        device_authorization_endpoint: 'https://auth/oauth2/device',
      })),
    });
    const run = link(qr, 'CQ==', '@other:hs');
    await settle();

    await run.confirm(true);
    await settle();

    expect(run.kinds()).toContain('approve-in-browser');
    expect(run.states.at(-1)).toEqual({ kind: 'done' });
  });

  it('emits not-sign-in-code for a code that is not a sign-in code', async () => {
    const { qr, flows } = setup();
    const run = link(qr, '');
    await settle();
    expect(run.kinds()).toEqual(['connecting', 'not-sign-in-code']);
    expect(run.completed()).toBe(true);
    expect(flows).toHaveLength(0);
  });

  it('fails for an account that is not live', async () => {
    const { qr, factory } = setup();
    const run = link(qr, 'CQ==', '@nobody:hs');
    await settle();
    expect(run.states).toEqual([
      { kind: 'connecting' },
      { kind: 'failed', reason: 'unknown' },
    ]);
    expect(factory.existingDevice).not.toHaveBeenCalled();
  });

  it.each<[QrLinkUpdate['kind'], Step | null, string[]]>([
    // Not connected yet, so there is no channel to send a decline over.
    ['connecting', 'negotiateProtocols', ['cancel:user_cancelled']],
    ['confirm-check-code', null, ['decline', 'cancel:user_cancelled']],
    // Secrets may be in flight, so the cancel goes first and alone.
    ['sharing-secrets', 'shareSecrets', ['cancel:user_cancelled']],
  ])('unsubscribing at %s cancels', async (kind, hung, tail) => {
    const { qr, flows } = setup((flow) => hung && flow.hang.add(hung));
    const run = link(qr);
    await settle();
    if (hung) await run.confirm(true);
    await settle();
    expect(run.states.at(-1)?.kind).toBe(kind);

    run.subscription.unsubscribe();
    if (kind === 'sharing-secrets') {
      expect(flows[0].cancel).toHaveBeenCalledWith('user_cancelled');
    }
    await settle();
    expect(flows[0].calls.slice(-tail.length)).toEqual(tail);
    expect(flows[0].declineLoginOnExistingDevice).toHaveBeenCalledTimes(
      tail.includes('decline') ? 1 : 0,
    );
  });

  it('cancels at once while secrets are being shared, even if a decline would hang', async () => {
    const { qr, flows } = setup((flow) => {
      flow.hang.add('shareSecrets');
      flow.declineLoginOnExistingDevice.mockReturnValue(
        new Promise<void>(() => undefined),
      );
    });
    const run = link(qr);
    await settle();
    await run.confirm(true);
    await settle();
    expect(flows[0].shareSecrets).toHaveBeenCalled();

    run.subscription.unsubscribe();
    expect(flows[0].cancel).toHaveBeenCalledWith('user_cancelled');
    expect(flows[0].declineLoginOnExistingDevice).not.toHaveBeenCalled();
  });

  it('cancels a flow that is still being created when unsubscribed', async () => {
    const { qr, factory, flows } = setup();
    let release!: () => void;
    const created = factory.existingDevice.getMockImplementation()!;
    factory.existingDevice.mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => (release = resolve));
      return created(...args);
    });
    const run = link(qr);
    await settle();
    run.subscription.unsubscribe();
    release();
    await settle();
    expect(flows[0].calls).toEqual(['cancel:user_cancelled']);
  });

  it('waits at the check code once connected, asking for no grant', async () => {
    const { qr, flows } = setup((flow) => flow.hang.add('negotiateProtocols'));
    const run = link(qr);
    await settle();
    // The flow id first leaves the engine with the check code, so nothing can answer earlier.
    flows[0].release('negotiateProtocols');
    await settle();
    expect(run.states.at(-1)?.kind).toBe('confirm-check-code');
    expect(flows[0].deviceAuthorizationGrant).not.toHaveBeenCalled();
  });

  it('counts only the first answer', async () => {
    const { qr } = setup();
    const run = link(qr);
    await settle();

    await expect(run.confirm(true)).resolves.toEqual({ ok: true, value: null });
    await expect(run.confirm(false)).resolves.toEqual({
      ok: false,
      failure: expect.objectContaining({ code: 'qr-flow-gone' }),
    });
    await settle();
    expect(run.states.at(-1)?.kind).toBe('done');
  });

  it.each(sdkReasons)('maps an SDK rejection with %s', async (reason) => {
    const { qr } = setup((flow) =>
      flow.failures.set('shareSecrets', new RendezvousError('failed', reason)),
    );
    const run = link(qr);
    await settle();
    await run.confirm(true);
    await settle();
    expect(run.states.at(-1)).toEqual({
      kind: 'failed',
      reason: qrSignInFailureOf(reason),
    });
  });

  it('leaves the session to the new device when sharing the secrets fails', async () => {
    const { qr, flows } = setup((flow) =>
      flow.failures.set(
        'shareSecrets',
        new RendezvousError(
          'failed',
          MSC4108FailureReason.UnexpectedMessageReceived,
        ),
      ),
    );
    const run = link(qr);
    await settle();
    await run.confirm(true);
    await settle();
    expect(run.states.at(-1)?.kind).toBe('failed');
    expect(flows[0].close).not.toHaveBeenCalled();
  });
});
