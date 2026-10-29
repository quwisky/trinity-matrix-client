import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import type { MatrixClient, ValidatedAuthMetadata } from 'matrix-js-sdk';
import { verifiedDeviceGrantMetadata } from '@trinity/util/matrix';
import {
  ClientRendezvousFailureReason,
  MSC4108FailureReason,
  RendezvousError,
} from 'matrix-js-sdk/lib/rendezvous';
import { Observable, from, of, throwError, type Subscription } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QrRendezvousFactory,
  type QrRendezvousFlow,
} from './qr-sign-in.adapter';
import {
  QR_LINK_IDENTITY_CHECK,
  QR_SIGN_IN_COMPLETION,
  type LinkedSecrets,
} from './qr-sign-in-completion.port';
import {
  qrSignInFailureOf,
  type ExistingDeviceState,
  type NewDeviceState,
} from './qr-sign-in.model';
import { QrSignInService } from './qr-sign-in.service';
import {
  AUTHENTICATION_HOMESERVER_DISCOVERY,
  type AuthenticationHomeserver,
} from '../homeserver-discovery.port';

type Step =
  | 'generateCode'
  | 'negotiateProtocols'
  | 'deviceAuthorizationGrant'
  | 'completeLoginOnNewDevice'
  | 'shareSecrets';

const metadata = { issuer: 'https://auth/' } as never;
const tokens = { access_token: 'at', token_type: 'Bearer' };
const secrets = { cross_signing: {} } as unknown as LinkedSecrets;
const signedIn = { id: 'new-client' } as unknown as MatrixClient;
const existingClient = {
  id: 'existing-client',
  getUserId: () => '@me:hs',
  getAuthMetadata: vi.fn(async () => metadata),
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

function setup(configure: (flow: FakeFlow) => void = () => undefined) {
  const flows: FakeFlow[] = [];
  const order: string[] = [];
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
        metadata,
        expires: null as string | null,
      }),
    ),
    existingDevice: vi.fn(
      async (
        _client: MatrixClient,
        bytes: Uint8Array,
        onFailure: (reason: string) => void,
      ) => (bytes.length ? build(onFailure, false) : null),
    ),
  };
  const completion = {
    deviceGrantClientId: vi.fn(() => of('client-id')),
    deviceGrantMetadata: vi.fn(
      (m: ValidatedAuthMetadata): Observable<ValidatedAuthMetadata> => of(m),
    ),
    forgetDeviceGrantClientId: vi.fn(() => of(undefined)),
    completeDeviceGrant: vi.fn(() => {
      order.push('completeDeviceGrant');
      return of(signedIn);
    }),
    importLinkedSecrets: vi.fn(() => of(true)),
  };
  const identity = { holdsPublishedIdentity: vi.fn(() => of(true)) };
  const discovery = {
    lookUp: vi.fn((): Observable<AuthenticationHomeserver> =>
      throwError(() => new Error('No homeserver found')),
    ),
  };
  const activeUserId = signal<string | null>('@me:hs');
  const clients = new Map<string, MatrixClient>([['@me:hs', existingClient]]);
  const matrix = {
    activeUserId: activeUserId.asReadonly(),
    clientFor: vi.fn((id: string) => clients.get(id) ?? null),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: QrRendezvousFactory, useValue: factory },
      { provide: QR_SIGN_IN_COMPLETION, useValue: completion },
      { provide: QR_LINK_IDENTITY_CHECK, useValue: identity },
      { provide: MatrixClientService, useValue: matrix },
      { provide: AUTHENTICATION_HOMESERVER_DISCOVERY, useValue: discovery },
    ],
  });
  return {
    flows,
    order,
    factory,
    completion,
    identity,
    discovery,
    activeUserId,
    clients,
    service: TestBed.inject(QrSignInService),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

function record<T extends { kind: string }>(
  state$: import('rxjs').Observable<T>,
) {
  const states: T[] = [];
  let completed = false;
  const subscription: Subscription = state$.subscribe({
    next: (state) => states.push(state),
    complete: () => (completed = true),
  });
  return {
    states,
    kinds: () => states.map((state) => state.kind),
    completed: () => completed,
    subscription,
  };
}

const sdkReasons = [
  ...Object.values(MSC4108FailureReason),
  ...Object.values(ClientRendezvousFailureReason),
];

describe('QrSignInService.signInByShowingCode', () => {
  it('runs creating → showing-code → confirm-check-code → waiting-for-approval → signing-in → done', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const { service, flows, completion, order } = setup();
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();

    expect(run.states).toEqual<NewDeviceState[]>([
      { kind: 'creating' },
      {
        kind: 'showing-code',
        qr: new Uint8Array([1, 2, 3]),
        expiresAt: 61_000,
      },
      { kind: 'confirm-check-code', code: '42' },
      { kind: 'waiting-for-approval', userCode: 'ABCD' },
      { kind: 'signing-in' },
      { kind: 'done', verified: true },
    ]);
    expect(run.completed()).toBe(true);
    const flow = flows[0];
    expect(flow.deviceAuthorizationGrant).toHaveBeenCalledWith({
      metadata,
      clientId: 'client-id',
      deviceId: expect.stringMatching(/^[A-Za-z0-9]{10}$/),
    });
    expect(flow.completeLoginOnNewDevice).toHaveBeenCalledWith({
      clientId: 'client-id',
    });
    expect(completion.deviceGrantClientId).toHaveBeenCalledWith(
      metadata,
      'https://hs',
    );
    // A normal sign-in asks the device-authorization endpoint once and keeps its client.
    expect(flow.deviceAuthorizationGrant).toHaveBeenCalledTimes(1);
    expect(completion.forgetDeviceGrantClientId).not.toHaveBeenCalled();
    expect(completion.completeDeviceGrant).toHaveBeenCalledWith(
      tokens,
      'client-id',
      metadata,
      'https://hs',
    );
    expect(completion.importLinkedSecrets).toHaveBeenCalledWith(
      signedIn,
      secrets,
    );
    // The existing device sends secrets only once the new device exists on the server.
    expect(order).toEqual(['completeDeviceGrant']);
    expect(
      completion.completeDeviceGrant.mock.invocationCallOrder[0],
    ).toBeLessThan(flow.shareSecrets.mock.invocationCallOrder[0]);
    expect(flow.cancel).not.toHaveBeenCalled();
    expect(flow.close).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  describe('a client id the provider rejects', () => {
    // What the SDK throws when the device endpoint answers with an OAuth error.
    const rejected = () => new Error('Invalid device authorization response');

    it('forgets the cached id, registers once more and retries the grant on the same flow', async () => {
      const { service, flows, completion } = setup((flow) =>
        flow.deviceAuthorizationGrant.mockRejectedValueOnce(rejected()),
      );
      completion.deviceGrantClientId
        .mockReturnValueOnce(of('stale-id'))
        .mockReturnValueOnce(of('fresh-id'));
      const run = record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'done', verified: true });
      expect(completion.forgetDeviceGrantClientId).toHaveBeenCalledWith(
        metadata,
        'https://hs',
      );
      const grants = flows[0].deviceAuthorizationGrant.mock
        .calls as unknown[][];
      expect(
        grants.map((call) => (call[0] as { clientId: string }).clientId),
      ).toEqual(['stale-id', 'fresh-id']);
      expect(flows[0].completeLoginOnNewDevice).toHaveBeenCalledWith({
        clientId: 'fresh-id',
      });
      expect(flows).toHaveLength(1);
    });

    it('ends unsupported when the new id is rejected too', async () => {
      const { service, flows, completion } = setup((flow) =>
        flow.failures.set('deviceAuthorizationGrant', rejected()),
      );
      const run = record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();

      expect(run.states.at(-1)).toEqual({
        kind: 'failed',
        reason: 'unsupported',
      });
      expect(flows[0].deviceAuthorizationGrant).toHaveBeenCalledTimes(2);
      expect(completion.forgetDeviceGrantClientId).toHaveBeenCalledTimes(1);
    });

    it('does not register again, nor report unsupported, when the channel closes', async () => {
      const { service, flows, completion } = setup((flow) =>
        flow.failures.set(
          'deviceAuthorizationGrant',
          new Error('Channel closed'),
        ),
      );
      const run = record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'unknown' });
      expect(flows[0].deviceAuthorizationGrant).toHaveBeenCalledTimes(1);
      expect(completion.forgetDeviceGrantClientId).not.toHaveBeenCalled();
    });

    it('does not register again when the network fails', async () => {
      const { service, flows, completion } = setup((flow) =>
        flow.failures.set(
          'deviceAuthorizationGrant',
          new TypeError('Failed to fetch'),
        ),
      );
      const run = record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'network' });
      expect(flows[0].deviceAuthorizationGrant).toHaveBeenCalledTimes(1);
      expect(completion.forgetDeviceGrantClientId).not.toHaveBeenCalled();
      expect(completion.deviceGrantClientId).toHaveBeenCalledTimes(1);
    });
  });

  describe('the device sign-in endpoints', () => {
    const DEVICE_METADATA = {
      issuer: 'https://op.example/',
      authorization_endpoint: 'https://op.example/authorize',
      token_endpoint: 'https://op.example/token',
      revocation_endpoint: 'https://op.example/revoke',
      device_authorization_endpoint: 'https://op.example/device',
    };
    const DOCUMENT =
      'https://op.example/.well-known/oauth-authorization-server';

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Sign in against `served` metadata, checked against the issuer's `document` (null: none). */
    async function signInWith(
      served: Record<string, unknown>,
      document: Record<string, unknown> | null,
    ) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          url === DOCUMENT && document
            ? new Response(JSON.stringify(document))
            : new Response('{}', { status: 404 }),
        ),
      );
      const ctx = setup();
      const opened = ctx.factory.newDevice.getMockImplementation()!;
      ctx.factory.newDevice.mockImplementation(async (url, onFailure) => ({
        ...(await opened(url, onFailure)),
        metadata: served as never,
      }));
      ctx.completion.deviceGrantMetadata.mockImplementation((m) =>
        from(verifiedDeviceGrantMetadata(m)),
      );
      const run = record(ctx.service.signInByShowingCode('https://hs', 'hs'));
      await vi.waitFor(() =>
        expect(['done', 'failed']).toContain(run.states.at(-1)?.kind),
      );
      return { ...ctx, run };
    }

    it.each([
      [
        "a token endpoint on another origin than the issuer's, with no document",
        { token_endpoint: 'https://hs.example/token' },
        null,
      ],
      [
        "a device endpoint on another origin than the issuer's, with no document",
        { device_authorization_endpoint: 'https://hs.example/device' },
        null,
      ],
      [
        'a device endpoint the document names differently',
        {},
        {
          ...DEVICE_METADATA,
          device_authorization_endpoint: 'https://op.example/other-device',
        },
      ],
    ])('starts no device sign-in for %s', async (_name, change, document) => {
      const { run, flows, completion } = await signInWith(
        { ...DEVICE_METADATA, ...change },
        document,
      );

      expect(run.states.at(-1)?.kind).toBe('failed');
      expect(flows[0].deviceAuthorizationGrant).not.toHaveBeenCalled();
      expect(flows[0].completeLoginOnNewDevice).not.toHaveBeenCalled();
      expect(completion.completeDeviceGrant).not.toHaveBeenCalled();
    });

    it('signs in at the endpoints the issuer confirms', async () => {
      const elsewhere = {
        ...DEVICE_METADATA,
        token_endpoint: 'https://login.example/token',
        device_authorization_endpoint: 'https://login.example/device',
      };
      const { run, flows, completion } = await signInWith(elsewhere, elsewhere);

      expect(run.states.at(-1)).toEqual({ kind: 'done', verified: true });
      expect(flows[0].deviceAuthorizationGrant).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: elsewhere }),
      );
      expect(completion.completeDeviceGrant).toHaveBeenCalledWith(
        tokens,
        'client-id',
        elsewhere,
        'https://hs',
      );
    });
  });

  describe('the server the other device reports', () => {
    function reporting(serverName: string | undefined) {
      return setup((flow) =>
        flow.negotiateProtocols.mockResolvedValue({ serverName } as never),
      );
    }

    it.each([
      ['another server', 'other.example'],
      ['no server', undefined],
    ])(
      'refuses %s before any grant or account sign-in',
      async (_name, serverName) => {
        const { service, flows, completion } = reporting(serverName);
        const run = record(service.signInByShowingCode('https://hs', 'hs'));
        await settle();

        expect(run.states.at(-1)).toEqual({
          kind: 'failed',
          reason: 'other-server',
        });
        expect(run.kinds()).not.toContain('confirm-check-code');
        expect(flows[0].deviceAuthorizationGrant).not.toHaveBeenCalled();
        expect(flows[0].completeLoginOnNewDevice).not.toHaveBeenCalled();
        expect(completion.completeDeviceGrant).not.toHaveBeenCalled();
        expect(flows[0].calls.slice(-2)).toEqual([
          'cancel:user_cancelled',
          'close',
        ]);
      },
    );

    it.each(['HS', 'hs.', 'Hs.'])(
      'accepts %s for the server name hs',
      async (serverName) => {
        const { service, discovery } = reporting(serverName);
        const run = record(service.signInByShowingCode('https://hs', 'hs'));
        await settle();

        expect(run.states.at(-1)).toEqual({ kind: 'done', verified: true });
        expect(discovery.lookUp).not.toHaveBeenCalled();
      },
    );

    // The homeserver was entered by URL, which discovery reports as `//host`.
    it.each([
      ['an exact host', 'hs.example', 'https://hs.example'],
      ['a host and the same port', 'localhost:8450', 'https://localhost:8450'],
      ['a host without a port', 'localhost', 'https://localhost:8448'],
      ['a host in another case', 'HS.Example.', 'https://hs.example'],
      ['a host on another port', 'localhost:9999', 'https://localhost:8448'],
      ['a parent domain', 'example.org', 'https://matrix.example.org'],
    ])(
      'accepts %s of the homeserver entered',
      async (_name, serverName, homeserverUrl) => {
        const { service, discovery } = reporting(serverName);
        const entered = `//${new URL(homeserverUrl).host}`;
        const run = record(service.signInByShowingCode(homeserverUrl, entered));
        await settle();

        expect(run.states.at(-1)).toEqual({ kind: 'done', verified: true });
        expect(discovery.lookUp).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['another host', 'other.example', 'https://hs.example'],
      ['a subdomain', 'other.hs.example', 'https://hs.example'],
      ['an unrelated server', 'matrix.org', 'https://other.example'],
    ])(
      'refuses %s of the homeserver entered',
      async (_name, serverName, homeserverUrl) => {
        const { service, flows } = reporting(serverName);
        const entered = `//${new URL(homeserverUrl).host}`;
        const run = record(service.signInByShowingCode(homeserverUrl, entered));
        await settle();

        expect(run.states.at(-1)).toEqual({
          kind: 'failed',
          reason: 'other-server',
        });
        expect(flows[0].deviceAuthorizationGrant).not.toHaveBeenCalled();
      },
    );

    it('accepts a server name whose subdomain is the homeserver name entered', async () => {
      const { service, discovery } = reporting('example.org');
      const run = record(
        service.signInByShowingCode(
          'https://matrix.example.org',
          'matrix.example.org',
        ),
      );
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'done', verified: true });
      expect(discovery.lookUp).not.toHaveBeenCalled();
    });

    it.each(['example.com', 'example.com:8448'])(
      'accepts %s when its well-known names the homeserver entered',
      async (serverName) => {
        const { service, discovery } = reporting(serverName);
        discovery.lookUp.mockReturnValue(
          of({ domain: serverName, baseUrl: 'https://matrix.example.org' }),
        );
        const run = record(
          service.signInByShowingCode(
            'https://matrix.example.org',
            '//matrix.example.org',
          ),
        );
        await settle();

        // The user ID form keeps a port, which a bare server name would lose.
        expect(discovery.lookUp).toHaveBeenCalledWith(`@_:${serverName}`);
        expect(run.states.at(-1)).toEqual({ kind: 'done', verified: true });
      },
    );

    it('refuses a server whose well-known names another homeserver', async () => {
      const { service, flows, discovery } = reporting('example.org');
      discovery.lookUp.mockReturnValue(
        of({ domain: 'example.org', baseUrl: 'https://matrix.example.org' }),
      );
      const run = record(service.signInByShowingCode('https://hs', '//hs'));
      await settle();

      expect(run.states.at(-1)).toEqual({
        kind: 'failed',
        reason: 'other-server',
      });
      expect(flows[0].deviceAuthorizationGrant).not.toHaveBeenCalled();
    });
  });

  describe('leaving while signing in', () => {
    /** A seam call that never answers and records when it is unsubscribed. */
    function pending() {
      const left = vi.fn();
      return {
        left,
        source: new Observable<never>(() => left),
      };
    }

    it('stops completing the device grant', async () => {
      const call = pending();
      const { service, completion } = setup();
      completion.completeDeviceGrant.mockReturnValue(call.source as never);
      const run = record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();
      expect(run.kinds().at(-1)).toBe('signing-in');

      run.subscription.unsubscribe();
      await settle();

      expect(call.left).toHaveBeenCalled();
      expect(run.kinds()).not.toContain('done');
    });

    it('stops importing the secrets', async () => {
      const call = pending();
      const { service, completion } = setup();
      completion.importLinkedSecrets.mockReturnValue(call.source as never);
      const run = record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();
      expect(completion.importLinkedSecrets).toHaveBeenCalled();

      run.subscription.unsubscribe();
      await settle();

      expect(call.left).toHaveBeenCalled();
      expect(run.kinds()).not.toContain('done');
    });
  });

  it('shows the expiry the server sent for the session', async () => {
    const now = Date.parse('2026-10-19T12:00:00Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { service, factory } = setup((flow) =>
      flow.hang.add('negotiateProtocols'),
    );
    const created = factory.newDevice.getMockImplementation()!;
    factory.newDevice.mockImplementation(async (url, onFailure) => ({
      ...(await created(url, onFailure)),
      expires: new Date(now + 10 * 60_000).toUTCString(),
    }));
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();

    expect(run.states.at(-1)).toEqual(
      expect.objectContaining({
        kind: 'showing-code',
        expiresAt: now + 10 * 60_000,
      }),
    );
    vi.restoreAllMocks();
  });

  it('falls back to a one-minute expiry when the Expires header cannot be read', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const { service, factory } = setup((flow) =>
      flow.hang.add('negotiateProtocols'),
    );
    const created = factory.newDevice.getMockImplementation()!;
    factory.newDevice.mockImplementation(async (url, onFailure) => ({
      ...(await created(url, onFailure)),
      expires: 'not a date',
    }));
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();

    expect(run.states.at(-1)).toEqual(
      expect.objectContaining({ kind: 'showing-code', expiresAt: 61_000 }),
    );
    vi.restoreAllMocks();
  });

  describe('a failure after the account is signed in', () => {
    it('ends done but unverified when sharing the secrets fails', async () => {
      const { service, flows } = setup((flow) =>
        flow.failures.set(
          'shareSecrets',
          new RendezvousError('failed', MSC4108FailureReason.UserCancelled),
        ),
      );
      const run = record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'done', verified: false });
      expect(run.kinds()).not.toContain('failed');
      expect(run.completed()).toBe(true);
      expect(flows[0].cancel).not.toHaveBeenCalled();
    });

    it('ends done but unverified when the other device cancels while secrets are shared', async () => {
      const { service, flows } = setup((flow) => flow.hang.add('shareSecrets'));
      const run = record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();

      flows[0].failSession(MSC4108FailureReason.UserCancelled);
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'done', verified: false });
      expect(run.kinds()).not.toContain('failed');
    });

    it('ends done but unverified when importing the secrets fails', async () => {
      const { service, completion } = setup();
      completion.importLinkedSecrets.mockReturnValue(
        throwError(() => new Error('import failed')),
      );
      const run = record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'done', verified: false });
      expect(run.kinds()).not.toContain('failed');
    });

    it('still fails when the account could not be signed in', async () => {
      const { service, completion } = setup();
      completion.completeDeviceGrant.mockReturnValue(
        throwError(() => new Error('store failed')),
      );
      const run = record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'unknown' });
    });
  });

  it('ends unverified when no secrets arrive', async () => {
    const { service, completion } = setup((flow) =>
      flow.shareSecrets.mockResolvedValue({} as never),
    );
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();
    expect(run.states.at(-1)).toEqual({ kind: 'done', verified: false });
    expect(completion.importLinkedSecrets).not.toHaveBeenCalled();
  });

  it('is cold', async () => {
    const { service, factory } = setup();
    service.signInByShowingCode('https://hs', 'hs');
    await settle();
    expect(factory.newDevice).not.toHaveBeenCalled();
  });

  it.each<[NewDeviceState['kind'], Step]>([
    ['creating', 'generateCode'],
    ['showing-code', 'negotiateProtocols'],
    ['confirm-check-code', 'deviceAuthorizationGrant'],
    ['waiting-for-approval', 'completeLoginOnNewDevice'],
    ['signing-in', 'shareSecrets'],
  ])('unsubscribing at %s cancels and closes', async (kind, hung) => {
    const { service, flows } = setup((flow) => flow.hang.add(hung));
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();
    expect(run.states.at(-1)?.kind).toBe(kind);

    run.subscription.unsubscribe();
    await settle();
    expect(flows[0].calls.slice(-2)).toEqual([
      'cancel:user_cancelled',
      'close',
    ]);
  });

  it('cancels a flow that is still being created when unsubscribed', async () => {
    const { service, factory, flows } = setup();
    let release!: () => void;
    const created = factory.newDevice.getMockImplementation()!;
    factory.newDevice.mockImplementation(async (url, onFailure) => {
      await new Promise<void>((resolve) => (release = resolve));
      return created(url, onFailure);
    });
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();
    run.subscription.unsubscribe();
    release();
    await settle();
    expect(flows[0].calls).toEqual(['cancel:user_cancelled', 'close']);
  });

  it.each(sdkReasons)('maps an SDK rejection with %s', async (reason) => {
    const { service } = setup((flow) =>
      flow.failures.set(
        'negotiateProtocols',
        new RendezvousError('failed', reason),
      ),
    );
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();
    expect(run.states.at(-1)).toEqual({
      kind: 'failed',
      reason: qrSignInFailureOf(reason),
    });
    expect(run.completed()).toBe(true);
  });

  it('reports a network failure', async () => {
    const { service } = setup((flow) =>
      flow.failures.set('generateCode', new TypeError('Failed to fetch')),
    );
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();
    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'network' });
  });

  it('fails expired when the session expires, and a new subscription shows a new code', async () => {
    const { service, flows, factory } = setup((flow) =>
      flow.hang.add('negotiateProtocols'),
    );
    const first = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();
    expect(first.states.at(-1)?.kind).toBe('showing-code');

    flows[0].failSession(ClientRendezvousFailureReason.Expired);
    await settle();
    expect(first.states.at(-1)).toEqual({ kind: 'failed', reason: 'expired' });
    expect(first.completed()).toBe(true);

    const second = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();
    expect(factory.newDevice).toHaveBeenCalledTimes(2);
    expect(flows[1].generateCode).toHaveBeenCalled();
    expect(second.states.at(-1)?.kind).toBe('showing-code');
  });

  it('ends declined when the existing device declines', async () => {
    // The SDK throws this when it receives the existing device's m.login.failure.
    const { service } = setup((flow) =>
      flow.failures.set(
        'completeLoginOnNewDevice',
        new RendezvousError('Failed', MSC4108FailureReason.UserCancelled),
      ),
    );
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();
    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'declined' });
  });

  it('reports a server without a rendezvous endpoint as unsupported', async () => {
    const { service, factory } = setup();
    factory.newDevice.mockRejectedValue(new Error('Invalid rendezvous URI'));
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();
    expect(run.states.at(-1)).toEqual({
      kind: 'failed',
      reason: 'unsupported',
    });
  });

  it('fails when the session reports a 404 while opening', async () => {
    // The SDK's send resolves on a 404 and reports it only through onFailure.
    const { service, factory, flows } = setup();
    const created = factory.newDevice.getMockImplementation()!;
    factory.newDevice.mockImplementation(async (url, onFailure) => {
      const result = await created(url, onFailure);
      onFailure(ClientRendezvousFailureReason.Unknown);
      return result;
    });
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();
    expect(run.kinds()).toEqual(['creating', 'failed']);
    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'unknown' });
    expect(flows[0].calls).toEqual(['close']);
  });

  it('reports the first failure only', async () => {
    const { service, flows } = setup((flow) =>
      flow.hang.add('negotiateProtocols'),
    );
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();
    flows[0].failSession(ClientRendezvousFailureReason.Expired);
    flows[0].failSession(ClientRendezvousFailureReason.Unknown);
    await settle();
    expect(run.kinds().filter((kind) => kind === 'failed')).toHaveLength(1);
  });
});

describe('QrSignInService.linkByScanning', () => {
  const qrBytes = new Uint8Array([9]);

  it('runs connecting → confirm-check-code → approve-in-browser → sharing-secrets → done', async () => {
    const { service, flows, factory } = setup();
    const link = service.linkByScanning(existingClient, qrBytes);
    const run = record(link.state$);
    await settle();
    expect(run.kinds()).toEqual(['connecting', 'confirm-check-code']);

    link.confirmCheckCode(true);
    await settle();
    expect(run.states).toEqual<ExistingDeviceState[]>([
      { kind: 'connecting' },
      { kind: 'confirm-check-code', code: '42' },
      {
        kind: 'approve-in-browser',
        verificationUri: 'https://auth/link?code=ABCD',
      },
      { kind: 'sharing-secrets' },
      { kind: 'done' },
    ]);
    expect(run.completed()).toBe(true);
    expect(factory.existingDevice).toHaveBeenCalledWith(
      existingClient,
      qrBytes,
      expect.any(Function),
    );
    expect(flows[0].deviceAuthorizationGrant).toHaveBeenCalledWith();
    expect(flows[0].cancel).not.toHaveBeenCalled();
    // The new device reads the secrets after this, so the session stays for it to delete.
    expect(flows[0].close).not.toHaveBeenCalled();
  });

  it('never shares secrets before the check code is confirmed', async () => {
    const { service, flows } = setup();
    const link = service.linkByScanning(existingClient, qrBytes);
    record(link.state$);
    await settle();
    await settle();
    expect(flows[0].shareSecrets).not.toHaveBeenCalled();
    expect(flows[0].deviceAuthorizationGrant).not.toHaveBeenCalled();

    link.confirmCheckCode(true);
    await settle();
    expect(flows[0].shareSecrets).toHaveBeenCalled();
  });

  it('cancels as insecure when the check codes differ, and does nothing else', async () => {
    const { service, flows } = setup();
    const link = service.linkByScanning(existingClient, qrBytes);
    const run = record(link.state$);
    await settle();

    link.confirmCheckCode(false);
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

  it.each([
    ['another origin', 'https://other.example/link?code=ABCD'],
    ['a look-alike host', 'https://auth.other.example/link'],
    ['an unparseable link', 'not a url'],
  ])(
    'fails insecure and never shows an approval link on %s',
    async (_name, verificationUri) => {
      const { service, flows } = setup((flow) =>
        flow.deviceAuthorizationGrant.mockResolvedValue({
          verificationUri,
        } as never),
      );
      const link = service.linkByScanning(existingClient, qrBytes);
      const run = record(link.state$);
      await settle();

      link.confirmCheckCode(true);
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'insecure' });
      expect(run.kinds()).not.toContain('approve-in-browser');
      expect(JSON.stringify(run.states)).not.toContain(verificationUri);
      expect(flows[0].shareSecrets).not.toHaveBeenCalled();
      expect(flows[0].calls.at(-1)).toBe('cancel:user_cancelled');
    },
  );

  it('accepts an approval link on the device-authorization endpoint origin', async () => {
    const accountClient = {
      getUserId: () => '@me:hs',
      getAuthMetadata: vi.fn(async () => ({
        issuer: 'https://id.example/',
        device_authorization_endpoint: 'https://auth/oauth2/device',
      })),
    } as unknown as MatrixClient;
    const { service } = setup();
    const link = service.linkByScanning(accountClient, qrBytes);
    const run = record(link.state$);
    await settle();

    link.confirmCheckCode(true);
    await settle();

    expect(run.kinds()).toContain('approve-in-browser');
    expect(run.states.at(-1)).toEqual({ kind: 'done' });
  });

  it('ignores a confirmation that arrives before the check code is shown', async () => {
    const { service, flows } = setup();
    const link = service.linkByScanning(existingClient, qrBytes);
    link.confirmCheckCode(true);
    const run = record(link.state$);
    await settle();
    expect(run.states.at(-1)?.kind).toBe('confirm-check-code');
    expect(flows[0].shareSecrets).not.toHaveBeenCalled();
  });

  it('emits not-sign-in-code for bytes that are not a sign-in code', async () => {
    const { service, flows } = setup();
    const run = record(
      service.linkByScanning(existingClient, new Uint8Array()).state$,
    );
    await settle();
    expect(run.kinds()).toEqual(['connecting', 'not-sign-in-code']);
    expect(run.completed()).toBe(true);
    expect(flows).toHaveLength(0);
  });

  it.each<[ExistingDeviceState['kind'], Step | null, string[]]>([
    // Not connected yet, so there is no channel to send a decline over.
    ['connecting', 'negotiateProtocols', ['cancel:user_cancelled']],
    ['confirm-check-code', null, ['decline', 'cancel:user_cancelled']],
    // Secrets may be in flight, so the cancel goes first and alone.
    ['sharing-secrets', 'shareSecrets', ['cancel:user_cancelled']],
  ])('unsubscribing at %s cancels', async (kind, hung, tail) => {
    const { service, flows } = setup((flow) => hung && flow.hang.add(hung));
    const link = service.linkByScanning(existingClient, qrBytes);
    const run = record(link.state$);
    await settle();
    if (hung) link.confirmCheckCode(true);
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
    const { service, flows } = setup((flow) => {
      flow.hang.add('shareSecrets');
      flow.declineLoginOnExistingDevice.mockReturnValue(
        new Promise<void>(() => undefined),
      );
    });
    const link = service.linkByScanning(existingClient, qrBytes);
    const run = record(link.state$);
    await settle();
    link.confirmCheckCode(true);
    await settle();
    expect(flows[0].shareSecrets).toHaveBeenCalled();

    run.subscription.unsubscribe();
    expect(flows[0].cancel).toHaveBeenCalledWith('user_cancelled');
    expect(flows[0].declineLoginOnExistingDevice).not.toHaveBeenCalled();
  });

  it('cancels a flow that is still being created when unsubscribed', async () => {
    const { service, factory, flows } = setup();
    let release!: () => void;
    const created = factory.existingDevice.getMockImplementation()!;
    factory.existingDevice.mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => (release = resolve));
      return created(...args);
    });
    const run = record(service.linkByScanning(existingClient, qrBytes).state$);
    await settle();
    run.subscription.unsubscribe();
    release();
    await settle();
    expect(flows[0].calls).toEqual(['cancel:user_cancelled']);
  });

  it.each([
    [true, false, 'done'],
    [false, true, 'failed'],
  ])(
    'counts only the first answer (%s, then %s)',
    async (first, second, end) => {
      const { service } = setup();
      const link = service.linkByScanning(existingClient, qrBytes);
      const run = record(link.state$);
      await settle();
      link.confirmCheckCode(first);
      link.confirmCheckCode(second);
      await settle();
      expect(run.states.at(-1)?.kind).toBe(end);
    },
  );

  it('ignores a confirmation sent while connecting', async () => {
    const { service, flows } = setup((flow) =>
      flow.hang.add('negotiateProtocols'),
    );
    const link = service.linkByScanning(existingClient, qrBytes);
    const run = record(link.state$);
    await settle();
    link.confirmCheckCode(true);
    flows[0].release('negotiateProtocols');
    await settle();
    expect(run.states.at(-1)?.kind).toBe('confirm-check-code');
    expect(flows[0].deviceAuthorizationGrant).not.toHaveBeenCalled();
    expect(flows[0].shareSecrets).not.toHaveBeenCalled();
  });

  it('gives a confirmation only to the current subscription', async () => {
    const { service, flows } = setup();
    const link = service.linkByScanning(existingClient, qrBytes);
    const stale = record(link.state$);
    await settle();
    stale.subscription.unsubscribe();
    const current = record(link.state$);
    await settle();

    link.confirmCheckCode(true);
    await settle();
    expect(flows[0].shareSecrets).not.toHaveBeenCalled();
    expect(current.states.at(-1)?.kind).toBe('done');
  });

  it.each(sdkReasons)('maps an SDK rejection with %s', async (reason) => {
    const { service } = setup((flow) =>
      flow.failures.set('shareSecrets', new RendezvousError('failed', reason)),
    );
    const link = service.linkByScanning(existingClient, qrBytes);
    const run = record(link.state$);
    await settle();
    link.confirmCheckCode(true);
    await settle();
    expect(run.states.at(-1)).toEqual({
      kind: 'failed',
      reason: qrSignInFailureOf(reason),
    });
  });
  it('leaves the session to the new device when sharing the secrets fails', async () => {
    const { service, flows } = setup((flow) =>
      flow.failures.set(
        'shareSecrets',
        new RendezvousError(
          'failed',
          MSC4108FailureReason.UnexpectedMessageReceived,
        ),
      ),
    );
    const link = service.linkByScanning(existingClient, qrBytes);
    const run = record(link.state$);
    await settle();
    link.confirmCheckCode(true);
    await settle();
    expect(run.states.at(-1)?.kind).toBe('failed');
    expect(flows[0].close).not.toHaveBeenCalled();
  });

  it('refuses the link, without asking, when the client has no user id', async () => {
    const { service, flows, identity } = setup();
    const anonymous = {
      ...existingClient,
      getUserId: () => null,
    } as unknown as MatrixClient;
    const link = service.linkByScanning(anonymous, qrBytes);
    const run = record(link.state$);
    await settle();

    link.confirmCheckCode(true);
    await settle();

    expect(identity.holdsPublishedIdentity).not.toHaveBeenCalled();
    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'unknown' });
    expect(flows[0].deviceAuthorizationGrant).not.toHaveBeenCalled();
    expect(flows[0].shareSecrets).not.toHaveBeenCalled();
  });

  it('refuses, before any grant or secret, keys that are not the published identity', async () => {
    const { service, flows, identity } = setup();
    identity.holdsPublishedIdentity.mockReturnValue(of(false));
    const link = service.linkByScanning(existingClient, qrBytes);
    const run = record(link.state$);
    await settle();

    link.confirmCheckCode(true);
    await settle();

    expect(identity.holdsPublishedIdentity).toHaveBeenCalledWith('@me:hs');
    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'unknown' });
    expect(flows[0].deviceAuthorizationGrant).not.toHaveBeenCalled();
    expect(flows[0].shareSecrets).not.toHaveBeenCalled();
    // The new device is told the link ended.
    expect(flows[0].calls.slice(-2)).toEqual([
      'decline',
      'cancel:user_cancelled',
    ]);
  });

  it('links as the account that was active when the linker was made', async () => {
    const { service, factory, activeUserId, clients } = setup();
    const linker = service.linkerForActiveAccount();
    expect(linker?.accountId).toBe('@me:hs');

    clients.set('@other:hs', { id: 'other' } as unknown as MatrixClient);
    activeUserId.set('@other:hs');
    record(linker!.link(qrBytes).state$);
    await settle();

    expect(factory.existingDevice).toHaveBeenCalledWith(
      existingClient,
      qrBytes,
      expect.any(Function),
    );
  });

  it('has no linker without a live active account', () => {
    const { service, activeUserId } = setup();
    activeUserId.set(null);

    expect(service.linkerForActiveAccount()).toBeNull();
  });
});
