import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  EMPTY,
  Observable,
  Subject,
  from,
  of,
  tap,
  throwError,
  type Subscription,
} from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_ENGINE,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import { SessionStorageService } from '@trinity/platform-native';
import { engineOk, verifiedDeviceGrantMetadata } from '@trinity/util/matrix';
import { FakeAuthEngine } from '../../contract/fake-auth-engine';
import { UnacceptableAccountError } from '../account-establishment';
import { AUTH_ENGINE } from '../auth-engine.token';
import { AUTH_METADATA } from '../auth-metadata.fixture';
import { AuthService } from '../auth.service';
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
  engine.accounts.add(NEW_ACCOUNT);
  engine.accounts.add(LINKING_ACCOUNT);
  const oidc = {
    deviceGrantMetadata: vi.fn((m: unknown): Observable<unknown> => of(m)),
    deviceGrantClientId: vi.fn(() => of('client-id')),
    forgetDeviceGrantClientId: vi.fn(() => of(undefined)),
    deviceGrantBinding: vi.fn(
      (_m: unknown, clientId: string): Observable<unknown> =>
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
  const sessionEngine = {
    logoutSession: vi.fn(() => of(engineOk(null))),
  };
  const activeAccountId = signal<string | null>(LINKING_ACCOUNT);
  TestBed.configureTestingModule({
    providers: [
      { provide: AUTH_ENGINE, useValue: engine },
      { provide: AuthService, useValue: auth },
      { provide: OidcClientService, useValue: oidc },
      { provide: SessionStorageService, useValue: storage },
      { provide: SESSION_ENGINE, useValue: sessionEngine },
      {
        provide: SessionStateService,
        useValue: {
          activeAccountId: activeAccountId.asReadonly(),
          accountIds: computed(() => [...engine.accounts]),
        },
      },
      { provide: QR_LINK_IDENTITY_CHECK, useValue: identity },
    ],
  });
  return {
    engine,
    oidc,
    auth,
    storage,
    identity,
    sessionEngine,
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

/** Shows a code and types `code` at the code step, as the panel does; `null` types nothing. */
function showCode(
  service: QrSignInService,
  code: string | null = '42',
  homeserverUrl = 'https://hs',
  serverName = 'hs',
) {
  const signIn = service.signInByShowingCode(homeserverUrl, serverName);
  const run = record(
    signIn.state$.pipe(
      tap((state) => {
        if (state.kind === 'enter-check-code' && code !== null) {
          signIn.enterCheckCode(code);
        }
      }),
    ),
  );
  return { ...run, signIn };
}

/** The session the fake's other device signs in, as the logout receives it. */
const signedOut = (baseUrl = 'https://hs', clientId = 'client-id') => ({
  baseUrl,
  userId: NEW_ACCOUNT,
  deviceId: 'QRDEVICE',
  accessToken: `qr-token-${clientId}`,
  refreshToken: `qr-refresh-${clientId}`,
  oidc: { ...PINNED, clientId },
});

describe('QrSignInService.signInByShowingCode', () => {
  it('runs creating → showing-code → enter-check-code → waiting-for-approval → signing-in → done', async () => {
    const { service, engine, oidc, auth, sessionEngine } = setup();
    const start = vi.spyOn(engine, 'signInWithQr');
    const run = showCode(service);
    await settle();

    expect(run.states).toEqual<NewDeviceState[]>([
      { kind: 'creating' },
      {
        kind: 'showing-code',
        qr: expect.any(Uint8Array),
        expiresAt: expect.any(Number),
      },
      { kind: 'enter-check-code' },
      { kind: 'waiting-for-approval', userCode: 'ABCD' },
      { kind: 'signing-in' },
      { kind: 'done' },
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
    // The server entered goes along, so the account's server is checked against it.
    expect(auth.establishDeviceGrant).toHaveBeenCalledWith(
      'https://hs',
      {
        user_id: NEW_ACCOUNT,
        device_id: 'QRDEVICE',
        access_token: 'qr-token-client-id',
        refresh_token: 'qr-refresh-client-id',
        accessTokenExpiresAt: expect.any(Number),
        oidc: { ...PINNED, clientId: 'client-id' },
      },
      'hs',
    );
    expect(engine.calls).toEqual([
      'authMetadata:https://hs',
      'signInWithQr:client-id',
      'answerQrSignIn:42',
    ]);
    expect(sessionEngine.logoutSession).not.toHaveBeenCalled();
    expect(oidc.revokeTokens).not.toHaveBeenCalled();
  });

  describe('the code typed', () => {
    it('reaches the engine as typed', async () => {
      const { service, engine } = setup();
      const run = showCode(service, null);
      await settle();
      expect(run.kinds().at(-1)).toBe('enter-check-code');

      run.signIn.enterCheckCode('07');
      await settle();

      expect(engine.calls).toContain('answerQrSignIn:07');
      // The fake's other device shows 42.
      expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'insecure' });
    });

    it('ignores a code typed before the code step', async () => {
      const { service, engine } = setup();
      engine.qrStop = { after: 'showing-code' };
      const run = showCode(service, null);
      await settle();

      run.signIn.enterCheckCode('42');
      await settle();

      expect(engine.calls.some((call) => call.startsWith('answer'))).toBe(
        false,
      );
    });

    it('sends only the first code', async () => {
      const { service, engine } = setup();
      const run = showCode(service, null);
      await settle();

      run.signIn.enterCheckCode('42');
      run.signIn.enterCheckCode('24');
      await settle();

      expect(
        engine.calls.filter((call) => call.startsWith('answerQrSignIn')),
      ).toEqual(['answerQrSignIn:42']);
      expect(run.states.at(-1)).toEqual({ kind: 'done' });
    });

    it('gives a code only to the current subscription', async () => {
      const { service, engine } = setup();
      const signIn = service.signInByShowingCode('https://hs', 'hs');
      const stale = record(signIn.state$);
      await settle();
      stale.subscription.unsubscribe();
      const current = record(signIn.state$);
      await settle();

      signIn.enterCheckCode('42');
      await settle();

      expect(current.states.at(-1)).toEqual({ kind: 'done' });
      expect(
        engine.calls.filter((call) => call.startsWith('answerQrSignIn')),
      ).toHaveLength(1);
    });
  });

  describe('the session the engine hands over', () => {
    it('is adopted and not signed out once the account is ready', async () => {
      const { service, sessionEngine } = setup();
      const run = showCode(service);
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'done' });
      expect(sessionEngine.logoutSession).not.toHaveBeenCalled();
    });

    it('is refused as other-server and signed out once when it is on another homeserver', async () => {
      const { service, engine, auth, storage, sessionEngine } = setup();
      engine.qrPeer.homeserverUrl = 'https://other.example';
      const run = showCode(service);
      await settle();

      expect(run.states.at(-1)).toEqual({
        kind: 'failed',
        reason: 'other-server',
      });
      expect(storage.record).not.toHaveBeenCalled();
      expect(auth.establishDeviceGrant).not.toHaveBeenCalled();
      expect(sessionEngine.logoutSession).toHaveBeenCalledOnce();
      expect(sessionEngine.logoutSession).toHaveBeenCalledWith(
        signedOut('https://other.example'),
      );
    });

    it('leaves an account this device already stores as it was, and signs the session out once', async () => {
      const { service, storage, auth, sessionEngine } = setup();
      storage.record.mockReturnValue(
        of({ baseUrl: 'https://hs', userId: NEW_ACCOUNT, deviceId: 'OLD' }),
      );
      const run = showCode(service);
      await settle();

      expect(run.states.at(-1)).toEqual({
        kind: 'failed',
        reason: 'already-signed-in',
      });
      expect(storage.record).toHaveBeenCalledWith(NEW_ACCOUNT);
      expect(auth.establishDeviceGrant).not.toHaveBeenCalled();
      expect(sessionEngine.logoutSession).toHaveBeenCalledOnce();
      expect(sessionEngine.logoutSession).toHaveBeenCalledWith(signedOut());
    });

    it.each([
      [
        'a failure reading the stored record',
        () => throwError(() => new Error('x')),
      ],
      ['a stored-record check that answers nothing', () => EMPTY],
    ])('signs the session out once on %s', async (_name, record) => {
      const { service, storage, auth, sessionEngine } = setup();
      storage.record.mockReturnValue(record());
      const run = showCode(service);
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'unknown' });
      expect(auth.establishDeviceGrant).not.toHaveBeenCalled();
      expect(sessionEngine.logoutSession).toHaveBeenCalledOnce();
    });

    it('signs the session out once when the sign-in is left before it is handed to establishing', async () => {
      const { service, storage, auth, sessionEngine } = setup();
      storage.record.mockReturnValue(new Observable(() => undefined));
      const run = showCode(service);
      await settle();
      expect(run.kinds().at(-1)).toBe('signing-in');

      run.subscription.unsubscribe();
      await settle();

      expect(auth.establishDeviceGrant).not.toHaveBeenCalled();
      expect(sessionEngine.logoutSession).toHaveBeenCalledOnce();
      expect(sessionEngine.logoutSession).toHaveBeenCalledWith(signedOut());
    });

    describe('once it is handed to establishing', () => {
      it.each([
        ['other-server', 'other-server'],
        ['unconfirmed', 'other-server'],
        ['malformed', 'unknown'],
      ] as const)(
        'signs the session out once when the account check refuses it (%s), before anything is stored',
        async (reason, shown) => {
          const { service, auth, sessionEngine } = setup();
          auth.establishDeviceGrant.mockReturnValue(
            throwError(() => new UnacceptableAccountError(reason, NEW_ACCOUNT)),
          );
          const run = showCode(service);
          await settle();

          expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: shown });
          // The engine drops what it holds for this user and device only on logoutSession.
          expect(sessionEngine.logoutSession).toHaveBeenCalledOnce();
          expect(sessionEngine.logoutSession).toHaveBeenCalledWith(signedOut());
        },
      );

      it.each([
        { kind: 'failed', failure: 'unprotected-storage-declined' },
        {
          kind: 'failed',
          failure: 'homeserver-mismatch',
          storedBaseUrl: 'https://other.example',
        },
        { kind: 'failed', failure: 'account-already-stored' },
        { kind: 'transition-in-progress' },
      ])(
        'signs the session out once when establishing refuses it before anything is stored ($kind $failure)',
        async (outcome) => {
          const { service, auth, sessionEngine } = setup();
          auth.establishDeviceGrant.mockReturnValue(
            of({ ...outcome, accountId: NEW_ACCOUNT, placement: 'background' }),
          );
          const run = showCode(service);
          await settle();

          expect(run.states.at(-1)).toEqual({
            kind: 'failed',
            reason: 'unknown',
          });
          expect(sessionEngine.logoutSession).toHaveBeenCalledOnce();
          expect(sessionEngine.logoutSession).toHaveBeenCalledWith(signedOut());
        },
      );

      it('signs nothing out when the sign-in is left while establishing runs', async () => {
        const { service, auth, sessionEngine } = setup();
        const left = vi.fn();
        auth.establishDeviceGrant.mockReturnValue(new Observable(() => left));
        const run = showCode(service);
        await settle();
        expect(run.kinds().at(-1)).toBe('signing-in');

        run.subscription.unsubscribe();
        await settle();

        expect(left).toHaveBeenCalled();
        expect(sessionEngine.logoutSession).not.toHaveBeenCalled();
      });

      it.each([
        [
          'an account that does not start',
          () =>
            of({
              kind: 'failed',
              failure: 'crypto-failure',
              accountId: NEW_ACCOUNT,
              placement: 'active',
            }),
        ],
        ['an error', () => throwError(() => new Error('boom'))],
        ['nothing', () => EMPTY],
      ])(
        'fails unknown and signs nothing out when establishing returns %s',
        async (_name, outcome) => {
          const { service, auth, sessionEngine } = setup();
          auth.establishDeviceGrant.mockReturnValue(outcome());
          const run = showCode(service);
          await settle();

          expect(run.states.at(-1)).toEqual({
            kind: 'failed',
            reason: 'unknown',
          });
          expect(sessionEngine.logoutSession).not.toHaveBeenCalled();
        },
      );
    });

    it.each([
      ['a wrong code', null, '24'],
      ['an engine failure after the tokens', 'signing-in', '42'],
    ])(
      'signs nothing out on %s, before any session is handed over',
      async (_name, stopAfter, code) => {
        const { service, engine, sessionEngine } = setup();
        if (stopAfter) engine.qrStop = { after: stopAfter, reason: 'network' };
        const run = showCode(service, code);
        await settle();

        expect(run.kinds().at(-1)).toBe('failed');
        expect(sessionEngine.logoutSession).not.toHaveBeenCalled();
      },
    );
  });

  it('passes on how the engine ended the sign-in', async () => {
    const { service, engine } = setup();
    engine.qrStop = { after: 'showing-code', reason: 'expired' };
    const run = showCode(service);
    await settle();

    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'expired' });
    expect(run.completed()).toBe(true);
  });

  it('fails without showing a code on a server with no OAuth metadata', async () => {
    const { service, engine } = setup();
    engine.metadata = null;
    const run = showCode(service);
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
  ] as const)(
    'fails at once, showing no code, when %s returns nothing',
    async (_name, step) => {
      const { service, oidc, engine } = setup();
      oidc[step].mockReturnValue(EMPTY as never);
      const run = showCode(service);
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'unknown' });
      expect(run.completed()).toBe(true);
      expect(engine.calls).not.toContain('signInWithQr:client-id');
    },
  );

  it('is cold', async () => {
    const { service, engine } = setup();
    service.signInByShowingCode('https://hs', 'hs');
    await settle();
    expect(engine.calls).toEqual([]);
  });

  it('cancels the engine flow when unsubscribed', async () => {
    const { service, engine } = setup();
    engine.qrStop = { after: 'showing-code' };
    const run = showCode(service);
    await settle();

    run.subscription.unsubscribe();
    expect(engine.calls.at(-1)).toBe('qr-cancelled');
  });

  describe('a client id the provider rejects', () => {
    it('forgets the cached id, registers once more and starts over with a new code', async () => {
      const { service, engine, oidc } = setup();
      engine.qrPeer.refusedClients.add('stale-id');
      oidc.deviceGrantClientId
        .mockReturnValueOnce(of('stale-id'))
        .mockReturnValueOnce(of('fresh-id'));
      const run = showCode(service);
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'done' });
      expect(oidc.forgetDeviceGrantClientId).toHaveBeenCalledWith(
        AUTH_METADATA,
        'https://hs',
      );
      expect(
        engine.calls.filter((call) => call.startsWith('signInWithQr')),
      ).toEqual(['signInWithQr:stale-id', 'signInWithQr:fresh-id']);
      expect(run.kinds().filter((kind) => kind === 'showing-code')).toEqual([
        'showing-code',
        'showing-code',
      ]);
      expect(oidc.deviceGrantBinding).toHaveBeenCalledWith(
        AUTH_METADATA,
        'fresh-id',
      );
    });

    it('ends unsupported when the new id is rejected too', async () => {
      const { service, engine, oidc } = setup();
      engine.qrPeer.refusedClients.add('client-id');
      const run = showCode(service);
      await settle();

      expect(run.states.at(-1)).toEqual({
        kind: 'failed',
        reason: 'unsupported',
      });
      expect(oidc.forgetDeviceGrantClientId).toHaveBeenCalledTimes(1);
      expect(
        engine.calls.filter((call) => call.startsWith('signInWithQr')),
      ).toHaveLength(2);
    });

    it('reports a network failure while registering again', async () => {
      const { service, engine, oidc } = setup();
      engine.qrPeer.refusedClients.add('client-id');
      oidc.deviceGrantClientId
        .mockReturnValueOnce(of('client-id'))
        .mockReturnValueOnce(
          throwError(() => new TypeError('Failed to fetch')),
        );
      const run = showCode(service);
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
      const run = showCode(ctx.service);
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

      expect(run.states.at(-1)).toEqual({ kind: 'done' });
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
});

describe('QrSignInService.linkerForActiveAccount', () => {
  const APPROVAL = 'https://op.example/link?code=ABCD';
  const LINKING_RECORD = {
    userId: LINKING_ACCOUNT,
    deviceId: 'LINKER',
    baseUrl: 'https://linker.example',
  };
  const confirms = (engine: FakeAuthEngine) =>
    engine.calls.filter((call) => call.startsWith('confirmQrLink'));

  function linking(code = SIGN_IN_CODE) {
    const ctx = setup();
    ctx.engine.qrPeer.verificationUri = APPROVAL;
    ctx.storage.record.mockReturnValue(of(LINKING_RECORD));
    const linker = ctx.service.linkerForActiveAccount();
    if (!linker) throw new Error('no linker');
    const link = linker.link(code);
    return { ...ctx, linker, link };
  }

  it('shows the code, checks the approval link and the identity, and confirms only on Continue', async () => {
    const { engine, identity, storage, link } = linking();
    const start = vi.spyOn(engine, 'linkDeviceWithQr');
    const run = record(link.state$);
    await settle();
    expect(run.states).toEqual<ExistingDeviceState[]>([
      { kind: 'connecting' },
      { kind: 'check-code', code: '42' },
      { kind: 'approve', verificationUri: APPROVAL },
    ]);
    expect(storage.record).toHaveBeenCalledWith(LINKING_ACCOUNT);
    expect(engine.calls).toContain('authMetadata:https://linker.example');
    expect(identity.holdsPublishedIdentity).toHaveBeenCalledWith(
      LINKING_ACCOUNT,
    );
    expect(confirms(engine)).toEqual([]);

    link.approve();
    await settle();
    expect(run.states.slice(3)).toEqual<ExistingDeviceState[]>([
      { kind: 'approve-in-browser', verificationUri: APPROVAL },
      { kind: 'sharing-secrets' },
      { kind: 'done' },
    ]);
    expect(run.completed()).toBe(true);
    expect(start).toHaveBeenCalledWith(LINKING_ACCOUNT, btoa('MATRIX-code'));
    expect(confirms(engine)).toEqual(['confirmQrLink']);
  });

  it.each([
    ['another origin', 'https://other.example/link?code=ABCD'],
    ['a look-alike host', 'https://op.example.other.example/link'],
    ['an http downgrade', 'http://op.example/link'],
    ['an unparseable link', 'not a url'],
  ])(
    'ends insecure, never confirming or showing the link, on %s',
    async (_name, verificationUri) => {
      const { engine, identity, link } = linking();
      engine.qrPeer.verificationUri = verificationUri;
      const run = record(link.state$);
      await settle();
      link.approve();
      await settle();

      expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'insecure' });
      expect(run.completed()).toBe(true);
      expect(JSON.stringify(run.states)).not.toContain(verificationUri);
      expect(identity.holdsPublishedIdentity).not.toHaveBeenCalled();
      expect(confirms(engine)).toEqual([]);
      // Leaving the engine's flow declines and cancels it on the new device.
      expect(engine.calls.at(-1)).toBe('qr-cancelled');
    },
  );

  it('accepts an approval link on the device-authorization origin', async () => {
    const { engine, link } = linking();
    engine.metadata = {
      ...AUTH_METADATA,
      issuer: 'https://id.example/',
      device_authorization_endpoint: 'https://device.example/oauth2/device',
    };
    engine.qrPeer.verificationUri = 'https://device.example/link';
    const run = record(link.state$);
    await settle();

    expect(run.states.at(-1)).toEqual({
      kind: 'approve',
      verificationUri: 'https://device.example/link',
    });
  });

  it('ends insecure when the account server publishes no OAuth metadata', async () => {
    const { engine, link } = linking();
    engine.metadata = null;
    const run = record(link.state$);
    await settle();

    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'insecure' });
    expect(confirms(engine)).toEqual([]);
  });

  it.each([
    ['keys that are not the published identity', () => of(false)],
    ['an identity check that fails', () => throwError(() => new Error('x'))],
    ['an identity check that answers nothing', () => EMPTY],
  ])('ends unknown, never confirming, for %s', async (_name, check) => {
    const { engine, identity, link } = linking();
    identity.holdsPublishedIdentity.mockImplementation(check);
    const run = record(link.state$);
    await settle();
    link.approve();
    await settle();

    expect(run.states.at(-1)).toEqual({ kind: 'failed', reason: 'unknown' });
    expect(run.kinds()).not.toContain('approve');
    expect(confirms(engine)).toEqual([]);
    expect(engine.calls.at(-1)).toBe('qr-cancelled');
  });

  it('ignores Continue before the approve step and while its checks run', async () => {
    const { engine, identity, link } = linking();
    const held = new Subject<boolean>();
    identity.holdsPublishedIdentity.mockReturnValue(held);
    link.approve();
    const run = record(link.state$);
    await settle();
    expect(run.states.at(-1)?.kind).toBe('check-code');

    link.approve();
    held.next(true);
    await settle();
    expect(run.states.at(-1)?.kind).toBe('approve');
    expect(confirms(engine)).toEqual([]);

    link.approve();
    await settle();
    expect(confirms(engine)).toEqual(['confirmQrLink']);
  });

  it('confirms once however often the person continues', async () => {
    const { engine, link } = linking();
    const run = record(link.state$);
    await settle();

    link.approve();
    link.approve();
    await settle();

    expect(run.states.at(-1)?.kind).toBe('done');
    expect(confirms(engine)).toEqual(['confirmQrLink']);
    expect(
      run.kinds().filter((kind) => kind === 'approve-in-browser'),
    ).toHaveLength(1);
  });

  it('shows the approval page on Continue, before the engine answers the confirm', async () => {
    const { engine, link } = linking();
    vi.spyOn(engine, 'confirmQrLink').mockReturnValue(new Subject());
    const run = record(link.state$);
    await settle();

    link.approve();

    expect(run.states.at(-1)).toEqual({
      kind: 'approve-in-browser',
      verificationUri: APPROVAL,
    });
  });

  it('ends unknown and cancels the engine flow when the confirm fails', async () => {
    const { engine, link } = linking();
    const run = record(link.state$);
    await settle();

    engine.failure = {
      kind: 'unexpected',
      code: 'qr-flow-gone',
      diagnostic: { kind: 'unexpected' },
    };
    link.approve();
    await settle();

    expect(run.states.slice(3)).toEqual<ExistingDeviceState[]>([
      { kind: 'approve-in-browser', verificationUri: APPROVAL },
      { kind: 'failed', reason: 'unknown' },
    ]);
    expect(run.completed()).toBe(true);
    expect(engine.calls.at(-1)).toBe('qr-cancelled');
  });

  it('gives Continue only to the current subscription', async () => {
    const { link } = linking();
    const stale = record(link.state$);
    await settle();
    stale.subscription.unsubscribe();
    const current = record(link.state$);
    await settle();

    link.approve();
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

  it('cancels the engine flow when unsubscribed at the approve step', async () => {
    const { engine, link } = linking();
    const run = record(link.state$);
    await settle();
    expect(run.states.at(-1)?.kind).toBe('approve');

    run.subscription.unsubscribe();

    expect(engine.calls.at(-1)).toBe('qr-cancelled');
    expect(confirms(engine)).toEqual([]);
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
