import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  EMPTY,
  Observable,
  from,
  of,
  throwError,
  type Subscription,
} from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { SessionStorageService } from '@trinity/platform-native';
import { verifiedDeviceGrantMetadata } from '@trinity/util/matrix';
import { FakeAuthEngine } from '../../contract/fake-auth-engine';
import { AUTH_ENGINE } from '../auth-engine.token';
import { AUTH_METADATA } from '../auth-metadata.fixture';
import { AuthService } from '../auth.service';
import {
  AUTHENTICATION_HOMESERVER_DISCOVERY,
  type AuthenticationHomeserver,
} from '../homeserver-discovery.port';
import { OidcClientService } from '../oidc-client.service';
import { QR_LINK_IDENTITY_CHECK } from './qr-link-identity-check.port';
import type { ExistingDeviceState, NewDeviceState } from './qr-sign-in.model';
import { QrSignInService } from './qr-sign-in.service';

const NEW_ACCOUNT = '@alice:example.org';
const LINKING_ACCOUNT = '@me:example.org';
const PINNED = {
  issuer: AUTH_METADATA.issuer,
  tokenEndpoint: 'https://op.example/verified-token',
  revocationEndpoint: 'https://op.example/verified-revoke',
};
const SIGN_IN_CODE = new TextEncoder().encode('MATRIX-code');

function setup() {
  const engine = new FakeAuthEngine();
  engine.qrRendezvous = true;
  engine.metadata = AUTH_METADATA;
  engine.qrPeer.serverName = 'hs';
  engine.accounts.add(NEW_ACCOUNT);
  engine.accounts.add(LINKING_ACCOUNT);
  const oidc = {
    deviceGrantMetadata: vi.fn((m: unknown): Observable<unknown> => of(m)),
    deviceGrantClientId: vi.fn(() => of('client-id')),
    forgetDeviceGrantClientId: vi.fn(() => of(undefined)),
    deviceGrantBinding: vi.fn((_m: unknown, clientId: string) =>
      of({ ...PINNED, clientId }),
    ),
    revokeTokens: vi.fn(() => of(undefined)),
  };
  const auth = {
    establishDeviceGrant: vi.fn((): Observable<unknown> =>
      of({ kind: 'ready', accountId: NEW_ACCOUNT, placement: 'background' }),
    ),
  };
  const storage = { record: vi.fn((): Observable<unknown> => of(null)) };
  const identity = { holdsPublishedIdentity: vi.fn(() => of(true)) };
  const discovery = {
    lookUp: vi.fn((): Observable<AuthenticationHomeserver> =>
      throwError(() => new Error('No homeserver found')),
    ),
  };
  const activeAccountId = signal<string | null>(LINKING_ACCOUNT);
  TestBed.configureTestingModule({
    providers: [
      { provide: AUTH_ENGINE, useValue: engine },
      { provide: AuthService, useValue: auth },
      { provide: OidcClientService, useValue: oidc },
      { provide: SessionStorageService, useValue: storage },
      {
        provide: SessionStateService,
        useValue: {
          activeAccountId: activeAccountId.asReadonly(),
          accountIds: computed(() => [...engine.accounts]),
        },
      },
      { provide: QR_LINK_IDENTITY_CHECK, useValue: identity },
      { provide: AUTHENTICATION_HOMESERVER_DISCOVERY, useValue: discovery },
    ],
  });
  return {
    engine,
    oidc,
    auth,
    storage,
    identity,
    discovery,
    activeAccountId,
    service: TestBed.inject(QrSignInService),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

function record<T extends { kind: string }>(state$: Observable<T>) {
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

const revoked = {
  accessToken: 'qr-token-client-id',
  refreshToken: 'qr-refresh-client-id',
};

describe('QrSignInService.signInByShowingCode', () => {
  it('runs creating → showing-code → confirm-check-code → waiting-for-approval → signing-in → done', async () => {
    const { service, engine, oidc, auth } = setup();
    const start = vi.spyOn(engine, 'signInWithQr');
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();

    expect(run.states).toEqual<NewDeviceState[]>([
      { kind: 'creating' },
      {
        kind: 'showing-code',
        qr: expect.any(Uint8Array),
        expiresAt: expect.any(Number),
      },
      { kind: 'confirm-check-code', code: '42' },
      { kind: 'waiting-for-approval', userCode: 'ABCD' },
      { kind: 'signing-in' },
      { kind: 'done', verified: true },
    ]);
    expect(run.completed()).toBe(true);
    const shown = run.states[1] as { qr: Uint8Array };
    expect(new TextDecoder().decode(shown.qr)).toMatch(/^MATRIX/);
    expect(oidc.deviceGrantMetadata).toHaveBeenCalledWith(AUTH_METADATA);
    expect(oidc.deviceGrantClientId).toHaveBeenCalledWith(
      AUTH_METADATA,
      'https://hs',
    );
    expect(start).toHaveBeenCalledWith('https://hs', {
      grantMetadata: AUTH_METADATA,
      clientId: 'client-id',
    });
    // A normal sign-in keeps its client.
    expect(oidc.forgetDeviceGrantClientId).not.toHaveBeenCalled();
    expect(oidc.deviceGrantBinding).toHaveBeenCalledWith(
      AUTH_METADATA,
      'client-id',
    );
    expect(auth.establishDeviceGrant).toHaveBeenCalledWith('https://hs', {
      user_id: NEW_ACCOUNT,
      device_id: 'QRDEVICE',
      access_token: 'qr-token-client-id',
      refresh_token: 'qr-refresh-client-id',
      accessTokenExpiresAt: expect.any(Number),
      oidc: { ...PINNED, clientId: 'client-id' },
    });
    // The secrets are shared only once the account is established on this device.
    expect(engine.calls).toEqual([
      'authMetadata:https://hs',
      'signInWithQr:client-id',
      'answerQrSignIn:server-accepted',
      `continueQrSignIn:${NEW_ACCOUNT}`,
    ]);
    expect(oidc.revokeTokens).not.toHaveBeenCalled();
  });

  it('ends unverified when the shared secrets do not verify this device', async () => {
    const { service, engine } = setup();
    engine.qrPeer.verifies = false;
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();

    expect(run.states.at(-1)).toEqual({ kind: 'done', verified: false });
  });

  it('passes on how the engine ended the sign-in', async () => {
    const { service, engine } = setup();
    engine.qrStop = { after: 'showing-code', reason: 'expired' };
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();

    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'expired' });
    expect(run.completed()).toBe(true);
  });

  it('fails without showing a code on a server with no OAuth metadata', async () => {
    const { service, engine } = setup();
    engine.metadata = null;
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();

    expect(run.states).toEqual([
      { kind: 'creating' },
      { kind: 'failed', reason: 'unknown' },
    ]);
    expect(engine.calls).not.toContain('signInWithQr:client-id');
  });

  it.each([
    ['verifying the device endpoints', 'deviceGrantMetadata'],
    ['registering the client', 'deviceGrantClientId'],
    ['pinning the endpoints', 'deviceGrantBinding'],
  ] as const)('fails at once when %s returns nothing', async (_name, step) => {
    const { service, oidc } = setup();
    oidc[step].mockReturnValue(EMPTY as never);
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();

    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'unknown' });
    expect(run.completed()).toBe(true);
  });

  it('fails at once when establishing the account returns nothing', async () => {
    const { service, auth } = setup();
    auth.establishDeviceGrant.mockReturnValue(EMPTY);
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();

    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'unknown' });
  });

  it('is cold', async () => {
    const { service, engine } = setup();
    service.signInByShowingCode('https://hs', 'hs');
    await settle();
    expect(engine.calls).toEqual([]);
  });

  it('cancels the engine flow when unsubscribed', async () => {
    const { service, engine } = setup();
    engine.qrStop = { after: 'showing-code' };
    const run = record(service.signInByShowingCode('https://hs', 'hs'));
    await settle();

    run.subscription.unsubscribe();
    expect(engine.calls.at(-1)).toBe('qr-cancelled');
  });

  describe('a client id the provider rejects', () => {
    it('forgets the cached id, registers once more and retries the grant on the same flow', async () => {
      const { service, engine, oidc } = setup();
      engine.qrPeer.refusedClients.add('stale-id');
      oidc.deviceGrantClientId
        .mockReturnValueOnce(of('stale-id'))
        .mockReturnValueOnce(of('fresh-id'));
      const run = record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'done', verified: true });
      expect(oidc.forgetDeviceGrantClientId).toHaveBeenCalledWith(
        AUTH_METADATA,
        'https://hs',
      );
      expect(engine.calls).toContain('answerQrSignIn:retry-grant:fresh-id');
      expect(
        engine.calls.filter((call) => call.startsWith('signInWithQr')),
      ).toEqual(['signInWithQr:stale-id']);
      expect(oidc.deviceGrantBinding).toHaveBeenCalledWith(
        AUTH_METADATA,
        'fresh-id',
      );
    });

    it('ends unsupported when the new id is rejected too', async () => {
      const { service, engine, oidc } = setup();
      engine.qrPeer.refusedClients.add('client-id');
      const run = record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();

      expect(run.states.at(-1)).toEqual({
        kind: 'failed',
        reason: 'unsupported',
      });
      expect(oidc.forgetDeviceGrantClientId).toHaveBeenCalledTimes(1);
      expect(engine.calls.at(-1)).toBe('qr-cancelled');
    });

    it('reports a network failure while registering again', async () => {
      const { service, engine, oidc } = setup();
      engine.qrPeer.refusedClients.add('client-id');
      oidc.deviceGrantClientId
        .mockReturnValueOnce(of('client-id'))
        .mockReturnValueOnce(
          throwError(() => new TypeError('Failed to fetch')),
        );
      const run = record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'network' });
    });
  });

  describe('the device sign-in endpoints', () => {
    const DEVICE_METADATA = {
      ...AUTH_METADATA,
      issuer: 'https://op.example/',
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
      served: typeof DEVICE_METADATA,
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
      ctx.engine.metadata = served;
      const start = vi.spyOn(ctx.engine, 'signInWithQr');
      ctx.oidc.deviceGrantMetadata.mockImplementation((m) =>
        from(verifiedDeviceGrantMetadata(m as typeof DEVICE_METADATA)),
      );
      const run = record(ctx.service.signInByShowingCode('https://hs', 'hs'));
      await vi.waitFor(() =>
        expect(['done', 'failed']).toContain(run.states.at(-1)?.kind),
      );
      return { ...ctx, run, start };
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
      const { run, start, auth } = await signInWith(
        { ...DEVICE_METADATA, ...change },
        document,
      );

      expect(run.states.at(-1)?.kind).toBe('failed');
      expect(start).not.toHaveBeenCalled();
      expect(auth.establishDeviceGrant).not.toHaveBeenCalled();
    });

    it('signs in at the endpoints the issuer confirms', async () => {
      const elsewhere = {
        ...DEVICE_METADATA,
        token_endpoint: 'https://login.example/token',
        device_authorization_endpoint: 'https://login.example/device',
      };
      const { run, start, oidc } = await signInWith(elsewhere, elsewhere);

      expect(run.states.at(-1)).toEqual({ kind: 'done', verified: true });
      expect(start).toHaveBeenCalledWith(
        'https://hs',
        expect.objectContaining({ grantMetadata: elsewhere }),
      );
      expect(oidc.deviceGrantBinding).toHaveBeenCalledWith(
        elsewhere,
        'client-id',
      );
    });
  });

  describe('the server the other device reports', () => {
    function reporting(serverName: string | null) {
      const ctx = setup();
      ctx.engine.qrPeer.serverName = serverName;
      return ctx;
    }

    it.each([
      ['another server', 'other.example'],
      ['no server', null],
    ])(
      'refuses %s before any grant or account sign-in',
      async (_name, serverName) => {
        const { service, engine, auth } = reporting(serverName);
        const run = record(service.signInByShowingCode('https://hs', 'hs'));
        await settle();

        expect(run.states.at(-1)).toEqual({
          kind: 'failed',
          reason: 'other-server',
        });
        expect(run.kinds()).not.toContain('confirm-check-code');
        expect(engine.calls).not.toContain('answerQrSignIn:server-accepted');
        expect(engine.calls.at(-1)).toBe('qr-cancelled');
        expect(auth.establishDeviceGrant).not.toHaveBeenCalled();
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
        const { service, engine } = reporting(serverName);
        const entered = `//${new URL(homeserverUrl).host}`;
        const run = record(service.signInByShowingCode(homeserverUrl, entered));
        await settle();

        expect(run.states.at(-1)).toEqual({
          kind: 'failed',
          reason: 'other-server',
        });
        expect(engine.calls).not.toContain('answerQrSignIn:server-accepted');
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
      const { service, engine, discovery } = reporting('example.org');
      discovery.lookUp.mockReturnValue(
        of({ domain: 'example.org', baseUrl: 'https://matrix.example.org' }),
      );
      const run = record(service.signInByShowingCode('https://hs', '//hs'));
      await settle();

      expect(run.states.at(-1)).toEqual({
        kind: 'failed',
        reason: 'other-server',
      });
      expect(engine.calls).not.toContain('answerQrSignIn:server-accepted');
    });
  });

  describe('the tokens the grant issued', () => {
    it('revokes them and establishes nothing when the engine cannot confirm the account', async () => {
      const { service, engine, oidc, auth } = setup();
      engine.qrStop = { after: 'signing-in', reason: 'network' };
      const run = record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'network' });
      expect(auth.establishDeviceGrant).not.toHaveBeenCalled();
      expect(oidc.revokeTokens).toHaveBeenCalledWith(
        'https://hs',
        { issuer: AUTH_METADATA.issuer, clientId: 'client-id' },
        revoked,
      );
    });

    it('revokes them when the sign-in is left while the account is confirmed', async () => {
      const { service, engine, oidc } = setup();
      engine.qrStop = { after: 'signing-in' };
      const run = record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();

      run.subscription.unsubscribe();

      expect(oidc.revokeTokens).toHaveBeenCalledWith(
        'https://hs',
        { issuer: AUTH_METADATA.issuer, clientId: 'client-id' },
        revoked,
      );
    });

    it('leaves an account this device already stores as it was, and revokes them', async () => {
      const { service, storage, oidc, auth } = setup();
      storage.record.mockReturnValue(
        of({ baseUrl: 'https://hs', userId: NEW_ACCOUNT, deviceId: 'OLD' }),
      );
      const run = record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();

      expect(run.states.at(-1)).toEqual({
        kind: 'failed',
        reason: 'already-signed-in',
      });
      expect(storage.record).toHaveBeenCalledWith(NEW_ACCOUNT);
      expect(auth.establishDeviceGrant).not.toHaveBeenCalled();
      expect(oidc.revokeTokens).toHaveBeenCalledWith(
        'https://hs',
        expect.objectContaining({ clientId: 'client-id' }),
        revoked,
      );
    });

    it('revokes nothing before any were issued', async () => {
      const { service, engine, oidc } = setup();
      engine.qrPeer.serverName = 'other.example';
      record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();

      expect(oidc.revokeTokens).not.toHaveBeenCalled();
    });

    it('hands them over once establishing the account starts, even when it is left', async () => {
      const { service, oidc, auth } = setup();
      const left = vi.fn();
      auth.establishDeviceGrant.mockReturnValue(new Observable(() => left));
      const run = record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();
      expect(run.kinds().at(-1)).toBe('signing-in');

      run.subscription.unsubscribe();
      await settle();

      expect(left).toHaveBeenCalled();
      expect(run.kinds()).not.toContain('done');
      expect(oidc.revokeTokens).not.toHaveBeenCalled();
    });

    it('fails, sharing no secrets, when the account runtime does not start the account', async () => {
      const { service, engine, auth } = setup();
      auth.establishDeviceGrant.mockReturnValue(
        of({
          kind: 'failed',
          failure: 'crypto-failure',
          accountId: NEW_ACCOUNT,
          placement: 'active',
        }),
      );
      const run = record(service.signInByShowingCode('https://hs', 'hs'));
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'unknown' });
      expect(engine.calls.some((call) => call.startsWith('continue'))).toBe(
        false,
      );
    });
  });
});

describe('QrSignInService.linkerForActiveAccount', () => {
  function linking(code = SIGN_IN_CODE) {
    const ctx = setup();
    const linker = ctx.service.linkerForActiveAccount();
    if (!linker) throw new Error('no linker');
    const link = linker.link(code);
    return { ...ctx, linker, link };
  }

  it('runs connecting → confirm-check-code → approve-in-browser → sharing-secrets → done', async () => {
    const { engine, identity, link } = linking();
    const start = vi.spyOn(engine, 'linkDeviceWithQr');
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
        verificationUri: 'https://auth.example.org/link',
      },
      { kind: 'sharing-secrets' },
      { kind: 'done' },
    ]);
    expect(run.completed()).toBe(true);
    expect(start).toHaveBeenCalledWith(LINKING_ACCOUNT, btoa('MATRIX-code'));
    expect(identity.holdsPublishedIdentity).toHaveBeenCalledWith(
      LINKING_ACCOUNT,
    );
    expect(engine.calls).toContain('confirmQrLink:true:true');
  });

  it('ends the link as insecure on a mismatch, without asking about the identity', async () => {
    const { engine, identity, link } = linking();
    const run = record(link.state$);
    await settle();

    link.confirmCheckCode(false);
    await settle();

    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'insecure' });
    expect(identity.holdsPublishedIdentity).not.toHaveBeenCalled();
    expect(engine.calls).toContain('confirmQrLink:false:false');
  });

  it.each([
    ['keys that are not the published identity', () => of(false)],
    ['an identity check that fails', () => throwError(() => new Error('x'))],
    ['an identity check that answers nothing', () => EMPTY],
  ])('refuses the link for %s', async (_name, check) => {
    const { engine, identity, link } = linking();
    identity.holdsPublishedIdentity.mockImplementation(check);
    const run = record(link.state$);
    await settle();

    link.confirmCheckCode(true);
    await settle();

    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'unknown' });
    expect(engine.calls).toContain('confirmQrLink:true:false');
    expect(run.kinds()).not.toContain('approve-in-browser');
  });

  it('ignores a confirmation that arrives before the check code is shown', async () => {
    const { engine, link } = linking();
    link.confirmCheckCode(true);
    const run = record(link.state$);
    await settle();

    expect(run.states.at(-1)?.kind).toBe('confirm-check-code');
    expect(engine.calls.some((call) => call.startsWith('confirmQrLink'))).toBe(
      false,
    );
  });

  it('ignores a confirmation sent while connecting', async () => {
    const ctx = setup();
    ctx.engine.qrStop = { after: 'connecting' };
    const link = ctx.service.linkerForActiveAccount()!.link(SIGN_IN_CODE);
    record(link.state$);
    await settle();

    link.confirmCheckCode(true);
    await settle();

    expect(ctx.identity.holdsPublishedIdentity).not.toHaveBeenCalled();
    expect(
      ctx.engine.calls.some((call) => call.startsWith('confirmQrLink')),
    ).toBe(false);
  });

  it.each([
    [true, false, 'done'],
    [false, true, 'failed'],
  ])(
    'counts only the first answer (%s, then %s)',
    async (first, second, end) => {
      const { engine, link } = linking();
      const run = record(link.state$);
      await settle();

      link.confirmCheckCode(first);
      link.confirmCheckCode(second);
      await settle();

      expect(run.states.at(-1)?.kind).toBe(end);
      expect(
        engine.calls.filter((call) => call.startsWith('confirmQrLink')),
      ).toHaveLength(1);
    },
  );

  it('gives a confirmation only to the current subscription', async () => {
    const { link } = linking();
    const stale = record(link.state$);
    await settle();
    stale.subscription.unsubscribe();
    const current = record(link.state$);
    await settle();

    link.confirmCheckCode(true);
    await settle();

    expect(current.states.at(-1)?.kind).toBe('done');
    expect(stale.kinds()).not.toContain('done');
  });

  it('emits not-sign-in-code for bytes that are not a sign-in code', async () => {
    const { link } = linking(new Uint8Array());
    const run = record(link.state$);
    await settle();

    expect(run.kinds()).toEqual(['connecting', 'not-sign-in-code']);
    expect(run.completed()).toBe(true);
  });

  it('cancels the engine flow when unsubscribed', async () => {
    const { engine, link } = linking();
    const run = record(link.state$);
    await settle();

    run.subscription.unsubscribe();

    expect(engine.calls.at(-1)).toBe('qr-cancelled');
  });

  it('links as the account that was active when the linker was made', async () => {
    const { engine, activeAccountId, linker } = linking();
    const start = vi.spyOn(engine, 'linkDeviceWithQr');
    expect(linker.accountId).toBe(LINKING_ACCOUNT);

    activeAccountId.set('@other:example.org');
    record(linker.link(SIGN_IN_CODE).state$);
    await settle();

    expect(start).toHaveBeenCalledWith(LINKING_ACCOUNT, expect.any(String));
  });

  it('has no linker without an active account', () => {
    const { service, activeAccountId } = setup();
    activeAccountId.set(null);

    expect(service.linkerForActiveAccount()).toBeNull();
  });

  it('has no linker when the active account is not live', () => {
    const { service, activeAccountId } = setup();
    activeAccountId.set('@gone:example.org');

    expect(service.linkerForActiveAccount()).toBeNull();
  });
});
