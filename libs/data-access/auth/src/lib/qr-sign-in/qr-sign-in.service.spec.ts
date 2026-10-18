import { TestBed } from '@angular/core/testing';
import type { MatrixClient } from 'matrix-js-sdk';
import {
  ClientRendezvousFailureReason,
  MSC4108FailureReason,
  RendezvousError,
} from 'matrix-js-sdk/lib/rendezvous';
import { of, type Subscription } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  QrRendezvousFactory,
  type QrRendezvousFlow,
} from './qr-sign-in.adapter';
import {
  QR_SIGN_IN_COMPLETION,
  type LinkedSecrets,
} from './qr-sign-in-completion.port';
import {
  qrSignInFailureOf,
  type ExistingDeviceState,
  type NewDeviceState,
} from './qr-sign-in.model';
import { QrSignInService } from './qr-sign-in.service';

type Step =
  | 'generateCode'
  | 'negotiateProtocols'
  | 'deviceAuthorizationGrant'
  | 'completeLoginOnNewDevice'
  | 'shareSecrets';

const metadata = { issuer: 'https://auth' } as never;
const tokens = { access_token: 'at', token_type: 'Bearer' };
const secrets = { cross_signing: {} } as unknown as LinkedSecrets;
const signedIn = { id: 'new-client' } as unknown as MatrixClient;
const existingClient = { id: 'existing-client' } as unknown as MatrixClient;

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
  negotiateProtocols = vi.fn(() => this.step('negotiateProtocols', {}));
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
    completeDeviceGrant: vi.fn(() => {
      order.push('completeDeviceGrant');
      return of(signedIn);
    }),
    importLinkedSecrets: vi.fn(() => of(true)),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: QrRendezvousFactory, useValue: factory },
      { provide: QR_SIGN_IN_COMPLETION, useValue: completion },
    ],
  });
  return {
    flows,
    order,
    factory,
    completion,
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
    const run = record(service.signInByShowingCode('https://hs'));
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
    expect(completion.deviceGrantClientId).toHaveBeenCalledWith(metadata);
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

  it('ends unverified when no secrets arrive', async () => {
    const { service, completion } = setup((flow) =>
      flow.shareSecrets.mockResolvedValue({} as never),
    );
    const run = record(service.signInByShowingCode('https://hs'));
    await settle();
    expect(run.states.at(-1)).toEqual({ kind: 'done', verified: false });
    expect(completion.importLinkedSecrets).not.toHaveBeenCalled();
  });

  it('is cold', async () => {
    const { service, factory } = setup();
    service.signInByShowingCode('https://hs');
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
    const run = record(service.signInByShowingCode('https://hs'));
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
    const run = record(service.signInByShowingCode('https://hs'));
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
    const run = record(service.signInByShowingCode('https://hs'));
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
    const run = record(service.signInByShowingCode('https://hs'));
    await settle();
    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'network' });
  });

  it('fails expired when the session expires, and a new subscription shows a new code', async () => {
    const { service, flows, factory } = setup((flow) =>
      flow.hang.add('negotiateProtocols'),
    );
    const first = record(service.signInByShowingCode('https://hs'));
    await settle();
    expect(first.states.at(-1)?.kind).toBe('showing-code');

    flows[0].failSession(ClientRendezvousFailureReason.Expired);
    await settle();
    expect(first.states.at(-1)).toEqual({ kind: 'failed', reason: 'expired' });
    expect(first.completed()).toBe(true);

    const second = record(service.signInByShowingCode('https://hs'));
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
    const run = record(service.signInByShowingCode('https://hs'));
    await settle();
    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'declined' });
  });

  it('reports a server without a rendezvous endpoint as unsupported', async () => {
    const { service, factory } = setup();
    factory.newDevice.mockRejectedValue(new Error('Invalid rendezvous URI'));
    const run = record(service.signInByShowingCode('https://hs'));
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
    const run = record(service.signInByShowingCode('https://hs'));
    await settle();
    expect(run.kinds()).toEqual(['creating', 'failed']);
    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'unknown' });
    expect(flows[0].calls).toEqual(['close']);
  });

  it('reports the first failure only', async () => {
    const { service, flows } = setup((flow) =>
      flow.hang.add('negotiateProtocols'),
    );
    const run = record(service.signInByShowingCode('https://hs'));
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
      'close',
    ]);
    expect(flows[0].deviceAuthorizationGrant).not.toHaveBeenCalled();
    expect(flows[0].shareSecrets).not.toHaveBeenCalled();
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
    ['connecting', 'negotiateProtocols', ['cancel:user_cancelled', 'close']],
    ['confirm-check-code', null, ['decline', 'cancel:user_cancelled', 'close']],
    [
      'sharing-secrets',
      'shareSecrets',
      ['decline', 'cancel:user_cancelled', 'close'],
    ],
  ])('unsubscribing at %s tells the other device', async (kind, hung, tail) => {
    const { service, flows } = setup((flow) => hung && flow.hang.add(hung));
    const link = service.linkByScanning(existingClient, qrBytes);
    const run = record(link.state$);
    await settle();
    if (hung) link.confirmCheckCode(true);
    await settle();
    expect(run.states.at(-1)?.kind).toBe(kind);

    run.subscription.unsubscribe();
    await settle();
    expect(flows[0].calls.slice(-tail.length)).toEqual(tail);
    expect(flows[0].declineLoginOnExistingDevice).toHaveBeenCalledTimes(
      tail.includes('decline') ? 1 : 0,
    );
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
    expect(flows[0].calls).toEqual(['cancel:user_cancelled', 'close']);
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
});
