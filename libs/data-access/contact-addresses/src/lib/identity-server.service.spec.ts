import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  EMPTY_SESSION,
  SESSION_SNAPSHOT,
  type SessionAccountStatus,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import {
  type EngineFailure,
  EngineRequestError,
  engineFail,
} from '@trinity/util/matrix';
import { type Observable, firstValueFrom, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeContactAddressesEngine,
  type FakeContactAccount,
} from '../contract/fake-contact-addresses-engine';
import { CONTACT_ADDRESSES_ENGINE } from './contact-addresses-engine.token';
import * as http from './identity-server-http';
import { IdentityServerService } from './identity-server.service';

vi.mock('./identity-server-http', () => ({
  registerWithIdentityServer: vi.fn(),
  getTerms: vi.fn(),
  agreeToTerms: vi.fn(),
  requestEmailToken: vi.fn(),
  hashedLookup: vi.fn(),
  newClientSecret: vi.fn(),
}));

const ALICE = '@alice:example.org';
const IS = 'https://is.example';

function refusal(httpStatus: number, errcode: string): EngineFailure {
  return {
    kind: 'http',
    code: 'request-failed',
    diagnostic: { kind: 'http', httpStatus, errcode },
  };
}

const unauthorized = () =>
  new EngineRequestError(refusal(401, 'M_UNAUTHORIZED'));

function setup(
  options: {
    account?: Partial<FakeContactAccount>;
    wellKnown?: string;
    signedIn?: boolean;
  } = {},
) {
  const engine = new FakeContactAddressesEngine();
  const live = options.signedIn !== false;
  if (live) engine.signIn(ALICE, options.account);
  engine.wellKnown = options.wellKnown ?? null;
  const session = signal<SessionSnapshot>({
    ...EMPTY_SESSION,
    accounts: live ? [{ accountId: ALICE } as SessionAccountStatus] : [],
  });
  TestBed.configureTestingModule({
    providers: [
      { provide: CONTACT_ADDRESSES_ENGINE, useValue: engine },
      { provide: SESSION_SNAPSHOT, useValue: session },
    ],
  });
  return Object.assign(TestBed.inject(IdentityServerService), {
    fake: engine,
    account: () => engine.accounts.get(ALICE)!,
    signOut: () => {
      engine.accounts.delete(ALICE);
      session.set(EMPTY_SESSION);
    },
  });
}

const TERMS = {
  privacy: {
    version: '1',
    fr: { name: 'Confidentialité', url: 'https://is.example/fr' },
    en: { name: 'Privacy', url: 'https://is.example/en' },
  },
  tos: { version: '2', de: { name: 'AGB', url: 'https://is.example/de' } },
};

beforeEach(() => {
  vi.mocked(http.registerWithIdentityServer).mockResolvedValue('is-token');
  vi.mocked(http.getTerms).mockResolvedValue({});
  vi.mocked(http.agreeToTerms).mockResolvedValue(undefined);
  vi.mocked(http.requestEmailToken).mockResolvedValue('sid1');
  vi.mocked(http.hashedLookup).mockResolvedValue([]);
  vi.mocked(http.newClientSecret).mockReturnValue('secret');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('IdentityServerService.choice', () => {
  it('reads the account choice', async () => {
    const s = setup({ account: { identityServer: { baseUrl: IS } } });
    expect(await firstValueFrom(s.choice(ALICE))).toEqual({
      kind: 'set',
      url: IS,
      source: 'account',
    });
  });

  it('reads an explicit off', async () => {
    const s = setup({ account: { identityServer: { baseUrl: null } } });
    expect(await firstValueFrom(s.choice(ALICE))).toEqual({ kind: 'off' });
  });

  it('falls back to well-known', async () => {
    const s = setup({ wellKnown: IS });
    expect(await firstValueFrom(s.choice(ALICE))).toEqual({
      kind: 'set',
      url: IS,
      source: 'well-known',
    });
  });

  it('ignores a non-https well-known', async () => {
    const s = setup({ wellKnown: 'http://is.example' });
    expect(await firstValueFrom(s.choice(ALICE))).toEqual({ kind: 'none' });
  });

  it('is none when nothing is stored or advertised', async () => {
    expect(await firstValueFrom(setup().choice(ALICE))).toEqual({
      kind: 'none',
    });
  });

  it('refuses without a client', async () => {
    expect(
      await firstValueFrom(setup({ signedIn: false }).choice(ALICE)),
    ).toEqual({ kind: 'refused', reason: 'account-unavailable' });
  });
});

describe('IdentityServerService.check', () => {
  it('accepts an identity server and returns the normalized url', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
    const s = setup();
    expect(await firstValueFrom(s.check(` ${IS}/ `))).toEqual({
      kind: 'ok',
      url: IS,
    });
    expect(s.account().identityServer).toBeUndefined();
  });

  it('refuses http without a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await firstValueFrom(setup().check('http://is.example'))).toEqual({
      kind: 'refused',
      reason: 'not-https',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a server without the versions endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404 }));
    expect(await firstValueFrom(setup().check(IS))).toEqual({
      kind: 'refused',
      reason: 'not-identity-server',
    });
  });

  it('reports an unreachable server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('x')));
    expect(await firstValueFrom(setup().check(IS))).toEqual({
      kind: 'refused',
      reason: 'unreachable',
    });
  });
});

describe('IdentityServerService.use and turnOff', () => {
  it('refuses http without a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const s = setup();
    expect(await firstValueFrom(s.use(ALICE, 'http://is.example'))).toEqual({
      kind: 'refused',
      reason: 'not-https',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a server that does not answer the versions probe', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404 }));
    const s = setup();
    expect(await firstValueFrom(s.use(ALICE, IS))).toEqual({
      kind: 'refused',
      reason: 'not-identity-server',
    });
    expect(s.account().identityServer).toBeUndefined();
  });

  it('reports an unreachable server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    );
    expect(await firstValueFrom(setup().use(ALICE, IS))).toEqual({
      kind: 'refused',
      reason: 'unreachable',
    });
  });

  it('refuses an unavailable account before probing the server', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await firstValueFrom(setup({ signedIn: false }).use(ALICE, IS)),
    ).toEqual({ kind: 'refused', reason: 'account-unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('saves the url without a trailing slash', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const s = setup();
    expect(await firstValueFrom(s.use(ALICE, `${IS}/`))).toEqual({
      kind: 'saved',
      url: IS,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${IS}/_matrix/identity/v2`);
    expect(s.account().identityServer).toEqual({ baseUrl: IS });
  });

  it('turns off by writing a null base_url', async () => {
    const s = setup();
    expect(await firstValueFrom(s.turnOff(ALICE))).toEqual({ kind: 'saved' });
    expect(s.account().identityServer).toEqual({ baseUrl: null });
  });

  it('reports a rate-limited write with its delay', async () => {
    const s = setup();
    vi.spyOn(s.fake, 'setIdentityServer').mockReturnValue(
      of(
        engineFail({
          kind: 'rate-limit',
          code: 'request-failed',
          diagnostic: { kind: 'rate-limit', retryAfterMs: 3000 },
        }),
      ),
    );
    expect(await firstValueFrom(s.turnOff(ALICE))).toEqual({
      kind: 'refused',
      reason: 'rate-limited',
      retryAfterMs: 3000,
    });
  });
});

describe('IdentityServerService terms', () => {
  it('is accepted when every policy url is recorded', async () => {
    vi.mocked(http.getTerms).mockResolvedValue(TERMS);
    const s = setup({
      account: {
        acceptedTerms: ['https://is.example/en', 'https://is.example/de'],
      },
    });
    expect(await firstValueFrom(s.terms(ALICE, `${IS}/`))).toEqual({
      kind: 'accepted',
    });
    expect(http.getTerms).toHaveBeenCalledWith(IS);
  });

  it('needs consent only for the missing policies, preferring en', async () => {
    vi.mocked(http.getTerms).mockResolvedValue(TERMS);
    const s = setup({ account: { acceptedTerms: ['https://is.example/de'] } });
    expect(await firstValueFrom(s.terms(ALICE, IS))).toEqual({
      kind: 'needs-consent',
      policies: [
        {
          id: 'privacy',
          name: 'Privacy',
          url: 'https://is.example/en',
          version: '1',
        },
      ],
    });
  });

  it('counts a policy accepted when any language url is recorded', async () => {
    vi.mocked(http.getTerms).mockResolvedValue(TERMS);
    const s = setup({
      account: {
        acceptedTerms: ['https://is.example/fr', 'https://is.example/de'],
      },
    });
    expect(await firstValueFrom(s.terms(ALICE, IS))).toEqual({
      kind: 'accepted',
    });
  });

  it('asks again for a new version served at a new url', async () => {
    vi.mocked(http.getTerms).mockResolvedValue({
      privacy: {
        version: '2.0',
        en: { name: 'Privacy', url: 'https://is.example/privacy-2' },
      },
      tos: { version: '1', en: { name: 'ToS', url: 'https://is.example/tos' } },
    });
    const s = setup({
      account: {
        acceptedTerms: [
          'https://is.example/privacy-1',
          'https://is.example/tos',
        ],
      },
    });
    expect(await firstValueFrom(s.terms(ALICE, IS))).toEqual({
      kind: 'needs-consent',
      policies: [
        {
          id: 'privacy',
          name: 'Privacy',
          url: 'https://is.example/privacy-2',
          version: '2.0',
        },
      ],
    });
  });

  it('drops malformed policies', async () => {
    vi.mocked(http.getTerms).mockResolvedValue({
      noVersion: { en: { name: 'A', url: 'https://is.example/a' } },
      badUrl: { version: '1', en: { name: 'B', url: 'http://is.example/b' } },
      badName: { version: '1', en: { name: 3, url: 'https://is.example/c' } },
      good: { version: '1', en: { name: 'G', url: 'https://is.example/g' } },
    });
    expect(await firstValueFrom(setup().terms(ALICE, IS))).toEqual({
      kind: 'needs-consent',
      policies: [
        { id: 'good', name: 'G', url: 'https://is.example/g', version: '1' },
      ],
    });
  });

  it('refuses when the server is unreachable', async () => {
    vi.mocked(http.getTerms).mockRejectedValue(
      new EngineRequestError({
        kind: 'network',
        code: 'request-failed',
        diagnostic: { kind: 'network' },
      }),
    );
    expect(await firstValueFrom(setup().terms(ALICE, IS))).toEqual({
      kind: 'refused',
      reason: 'unreachable',
    });
  });

  it('agrees to terms and appends the urls', async () => {
    const s = setup({ account: { acceptedTerms: ['https://old'] } });
    const policies = [
      {
        id: 'privacy',
        name: 'Privacy',
        url: 'https://is.example/en',
        version: '1',
      },
    ];
    expect(await firstValueFrom(s.acceptTerms(ALICE, IS, policies))).toEqual({
      kind: 'accepted',
    });
    expect(http.agreeToTerms).toHaveBeenCalledWith(IS, 'is-token', [
      'https://is.example/en',
    ]);
    expect(s.account().acceptedTerms).toEqual([
      'https://old',
      'https://is.example/en',
    ]);
  });
});

describe('IdentityServerService token', () => {
  const policies = [
    { id: 'p', name: 'P', url: 'https://is.example/p', version: '1' },
  ];

  it('registers with the account’s OpenID token and reuses the token', async () => {
    const s = setup();
    await firstValueFrom(s.acceptTerms(ALICE, IS, policies));
    await firstValueFrom(s.acceptTerms(ALICE, IS, policies));
    expect(http.registerWithIdentityServer).toHaveBeenCalledTimes(1);
    expect(http.registerWithIdentityServer).toHaveBeenCalledWith(
      IS,
      s.fake.openId,
    );
  });

  it('shares one token between a url and its trailing-slash form', async () => {
    const s = setup();
    await firstValueFrom(s.acceptTerms(ALICE, IS, policies));
    await firstValueFrom(s.acceptTerms(ALICE, `${IS}/`, policies));
    expect(http.registerWithIdentityServer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(http.agreeToTerms).mock.calls[1][0]).toBe(IS);
  });

  it('is renewed once after a 401 and retried once', async () => {
    const s = setup();
    vi.mocked(http.agreeToTerms)
      .mockRejectedValueOnce(unauthorized())
      .mockResolvedValue(undefined);
    expect(await firstValueFrom(s.acceptTerms(ALICE, IS, policies))).toEqual({
      kind: 'accepted',
    });
    expect(http.registerWithIdentityServer).toHaveBeenCalledTimes(2);
    expect(http.agreeToTerms).toHaveBeenCalledTimes(2);
  });

  it('refuses after a second 401', async () => {
    const s = setup();
    vi.mocked(http.agreeToTerms).mockRejectedValue(unauthorized());
    expect(await firstValueFrom(s.acceptTerms(ALICE, IS, policies))).toEqual({
      kind: 'refused',
      reason: 'failed',
    });
    expect(http.registerWithIdentityServer).toHaveBeenCalledTimes(2);
    expect(http.agreeToTerms).toHaveBeenCalledTimes(2);
  });

  it('refuses an unavailable account without asking the identity server', async () => {
    const s = setup({ signedIn: false });
    expect(await firstValueFrom(s.acceptTerms(ALICE, IS, policies))).toEqual({
      kind: 'refused',
      reason: 'account-unavailable',
    });
    expect(http.registerWithIdentityServer).not.toHaveBeenCalled();
  });

  it('makes no identity-server call once the account is gone, with a token cached', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const s = setup();
    await firstValueFrom(s.findable(ALICE, IS, ['a@x.org']));
    vi.clearAllMocks();
    s.signOut();

    const calls: Observable<unknown>[] = [
      s.findable(ALICE, IS, ['a@x.org']),
      s.sendPublishLink(ALICE, IS, 'a@x.org'),
      s.resendPublishLink(PENDING),
      s.publish(PENDING),
      s.acceptTerms(ALICE, IS, policies),
      s.terms(ALICE, IS),
      s.use(ALICE, IS),
    ];
    for (const call of calls) {
      expect(await firstValueFrom(call)).toEqual({
        kind: 'refused',
        reason: 'account-unavailable',
      });
    }
    for (const request of [
      http.registerWithIdentityServer,
      http.getTerms,
      http.agreeToTerms,
      http.requestEmailToken,
      http.hashedLookup,
    ]) {
      expect(request).not.toHaveBeenCalled();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('makes no identity-server call for a queued call whose account went meanwhile', async () => {
    const s = setup();
    let finish: (value: never[]) => void = () => undefined;
    vi.mocked(http.hashedLookup).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const first = firstValueFrom(s.findable(ALICE, IS, ['a@x.org']));
    const queued = [
      firstValueFrom(s.findable(ALICE, IS, ['b@x.org'])),
      firstValueFrom(s.sendPublishLink(ALICE, IS, 'a@x.org')),
    ];
    await vi.waitFor(() => expect(http.hashedLookup).toHaveBeenCalledTimes(1));

    s.signOut();
    finish([]);

    await first;
    for (const result of await Promise.all(queued)) {
      expect(result).toEqual({
        kind: 'refused',
        reason: 'account-unavailable',
      });
    }
    expect(http.hashedLookup).toHaveBeenCalledTimes(1);
    expect(http.requestEmailToken).not.toHaveBeenCalled();
    expect(http.registerWithIdentityServer).toHaveBeenCalledTimes(1);
  });

  it('logs nothing', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const s = setup();
    await firstValueFrom(s.acceptTerms(ALICE, IS, policies));
    vi.mocked(http.agreeToTerms).mockRejectedValue(unauthorized());
    await firstValueFrom(s.acceptTerms(ALICE, IS, policies));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    spies.forEach((spy) => spy.mockRestore());
  });
});

const PENDING = {
  accountId: ALICE,
  url: IS,
  email: 'a@x.org',
  sid: 'sid1',
  clientSecret: 'secret',
  sendAttempt: 1,
};

describe('IdentityServerService.findable', () => {
  it('counts only addresses mapped to this account', async () => {
    const s = setup();
    vi.mocked(http.hashedLookup).mockResolvedValue([
      { address: 'a@x.org', mxid: ALICE },
      { address: 'b@x.org', mxid: '@bob:example.org' },
    ]);
    const result = await firstValueFrom(
      s.findable(ALICE, IS, ['a@x.org', 'b@x.org', 'c@x.org']),
    );
    expect(result).toEqual({ kind: 'loaded', published: new Set(['a@x.org']) });
    expect(http.hashedLookup).toHaveBeenCalledWith(IS, 'is-token', [
      'a@x.org',
      'b@x.org',
      'c@x.org',
    ]);
  });

  it('asks for the terms when the account has not signed the server’s', async () => {
    const s = setup();
    vi.mocked(http.hashedLookup).mockRejectedValue(
      new EngineRequestError(refusal(403, 'M_TERMS_NOT_SIGNED')),
    );
    expect(await firstValueFrom(s.findable(ALICE, IS, ['a@x.org']))).toEqual({
      kind: 'terms-needed',
    });
  });

  it('answers an empty list without contacting the server', async () => {
    const s = setup();
    const openId = vi.spyOn(s.fake, 'openIdToken');
    expect(await firstValueFrom(s.findable(ALICE, IS, []))).toEqual({
      kind: 'loaded',
      published: new Set(),
    });
    expect(http.registerWithIdentityServer).not.toHaveBeenCalled();
    expect(openId).not.toHaveBeenCalled();
    expect(http.hashedLookup).not.toHaveBeenCalled();
  });

  it('registers once for two lookups at one server started together', async () => {
    const s = setup();
    const loaded = { kind: 'loaded', published: new Set() };

    expect(
      await Promise.all([
        firstValueFrom(s.findable(ALICE, IS, ['a@x.org'])),
        firstValueFrom(s.findable(ALICE, IS, ['b@x.org'])),
      ]),
    ).toEqual([loaded, loaded]);
    expect(http.registerWithIdentityServer).toHaveBeenCalledTimes(1);
    expect(http.hashedLookup).toHaveBeenCalledTimes(2);
  });

  it('starts a second server’s lookup only after the first settles', async () => {
    const s = setup();
    let finish: (value: never[]) => void = () => undefined;
    vi.mocked(http.hashedLookup).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const first = firstValueFrom(s.findable(ALICE, IS, ['a@x.org']));
    const second = firstValueFrom(
      s.findable(ALICE, 'https://other.example', ['a@x.org']),
    );
    await vi.waitFor(() => expect(http.hashedLookup).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(http.registerWithIdentityServer).not.toHaveBeenCalledWith(
      'https://other.example',
      expect.anything(),
    );

    finish([]);
    await first;
    await second;
    expect(vi.mocked(http.hashedLookup).mock.calls.map((c) => c[0])).toEqual([
      IS,
      'https://other.example',
    ]);
  });

  it('refuses on failure, a server without sha256 included', async () => {
    const s = setup();
    vi.mocked(http.hashedLookup).mockRejectedValue(
      new Error('The identity server offers no sha256 lookup'),
    );
    expect(await firstValueFrom(s.findable(ALICE, IS, ['a@x.org']))).toEqual({
      kind: 'refused',
      reason: 'failed',
    });
  });
});

describe('IdentityServerService publish', () => {
  it('sends the link', async () => {
    const s = setup();
    expect(
      await firstValueFrom(s.sendPublishLink(ALICE, `${IS}/`, 'a@x.org')),
    ).toEqual({ kind: 'sent', pending: PENDING });
    expect(http.requestEmailToken).toHaveBeenCalledWith(
      IS,
      'is-token',
      expect.objectContaining({
        email: 'a@x.org',
        clientSecret: 'secret',
        sendAttempt: 1,
      }),
    );
  });

  it('resends with the same secret and a higher attempt', async () => {
    const s = setup();
    expect(await firstValueFrom(s.resendPublishLink(PENDING))).toEqual({
      kind: 'sent',
      pending: { ...PENDING, sendAttempt: 2 },
    });
    expect(http.requestEmailToken).toHaveBeenCalledWith(
      IS,
      'is-token',
      expect.objectContaining({
        email: 'a@x.org',
        clientSecret: 'secret',
        sendAttempt: 2,
      }),
    );
  });

  it('binds at the host only', async () => {
    const s = setup();
    s.fake.sessions.set('sid1', {
      clientSecret: 'secret',
      address: 'a@x.org',
      validated: true,
    });
    const bind = vi.spyOn(s.fake, 'bindThreePid');
    expect(await firstValueFrom(s.publish(PENDING))).toEqual({
      kind: 'published',
    });
    expect(bind).toHaveBeenCalledWith(ALICE, {
      sid: 'sid1',
      clientSecret: 'secret',
      idServer: 'is.example',
      idAccessToken: 'is-token',
    });
  });

  it('reports not-verified before the link is opened', async () => {
    const s = setup();
    s.fake.sessions.set('sid1', {
      clientSecret: 'secret',
      address: 'a@x.org',
      validated: false,
    });
    expect(await firstValueFrom(s.publish(PENDING))).toEqual({
      kind: 'not-verified',
      pending: PENDING,
    });
  });

  it('renews the identity token when the homeserver relays a 401', async () => {
    const s = setup();
    vi.spyOn(s.fake, 'bindThreePid')
      .mockReturnValueOnce(of(engineFail(refusal(401, 'M_UNAUTHORIZED'))))
      .mockReturnValue(of({ ok: true, value: null }));
    expect(await firstValueFrom(s.publish(PENDING))).toEqual({
      kind: 'published',
    });
    expect(http.registerWithIdentityServer).toHaveBeenCalledTimes(2);
  });

  it('refuses other errors', async () => {
    const s = setup();
    vi.spyOn(s.fake, 'bindThreePid').mockReturnValue(
      of(
        engineFail({
          kind: 'server',
          code: 'request-failed',
          diagnostic: { kind: 'server', httpStatus: 500, errcode: 'M_UNKNOWN' },
        }),
      ),
    );
    expect(await firstValueFrom(s.publish(PENDING))).toEqual({
      kind: 'refused',
      reason: 'failed',
    });
  });
});

describe('IdentityServerService unpublish', () => {
  it('unbinds at the given server', async () => {
    const s = setup();
    const unbind = vi.spyOn(s.fake, 'unbindThreePid');
    expect(
      await firstValueFrom(s.unpublish(ALICE, `${IS}/`, 'a@x.org')),
    ).toEqual({ kind: 'unpublished' });
    expect(unbind).toHaveBeenCalledWith(ALICE, {
      medium: 'email',
      address: 'a@x.org',
      idServer: 'is.example',
    });
  });

  it('treats a no-support server as unpublished', async () => {
    const s = setup();
    vi.spyOn(s.fake, 'unbindThreePid').mockReturnValue(
      of({ ok: true, value: 'no-support' as const }),
    );
    expect(await firstValueFrom(s.unpublish(ALICE, IS, 'a@x.org'))).toEqual({
      kind: 'unpublished',
    });
  });

  it('unpublishAll of nothing unpublishes nothing', async () => {
    const s = setup();
    const unbind = vi.spyOn(s.fake, 'unbindThreePid');
    expect(await firstValueFrom(s.unpublishAll(ALICE, IS, []))).toEqual({
      kind: 'unpublished',
    });
    expect(unbind).not.toHaveBeenCalled();
  });

  it('unpublishAll stops at the first refusal and emits it', async () => {
    const s = setup();
    const unbind = vi
      .spyOn(s.fake, 'unbindThreePid')
      .mockReturnValueOnce(of({ ok: true, value: 'success' as const }))
      .mockReturnValueOnce(of(engineFail(refusal(400, 'M_UNKNOWN'))));
    expect(
      await firstValueFrom(s.unpublishAll(ALICE, IS, ['a', 'b', 'c'])),
    ).toEqual({ kind: 'refused', reason: 'failed' });
    expect(unbind).toHaveBeenCalledTimes(2);
  });

  it('unpublishAll unpublishes every address in order', async () => {
    const s = setup();
    const unbind = vi.spyOn(s.fake, 'unbindThreePid');
    expect(await firstValueFrom(s.unpublishAll(ALICE, IS, ['a', 'b']))).toEqual(
      { kind: 'unpublished' },
    );
    expect(unbind.mock.calls.map((c) => c[1].address)).toEqual(['a', 'b']);
  });
});
