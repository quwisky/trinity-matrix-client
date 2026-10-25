import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { MatrixError } from '@trinity/util/matrix';
import { SERVICE_TYPES } from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityServerService } from './identity-server.service';

const ALICE = '@alice:example.org';
const IS = 'https://is.example';

function unauthorized(): MatrixError {
  return new MatrixError({ errcode: 'M_UNAUTHORIZED', error: 'no' }, 401);
}

function setup(
  options: {
    accountData?: Record<string, unknown>;
    wellKnown?: unknown;
    terms?: unknown;
    client?: boolean;
  } = {},
) {
  const accountData = { ...options.accountData };
  const client = {
    getAccountDataFromServer: vi.fn(
      async (type: string) => accountData[type] ?? null,
    ),
    setAccountData: vi.fn(async (type: string, content: unknown) => {
      accountData[type] = content;
      return {};
    }),
    getClientWellKnown: vi.fn(() => options.wellKnown),
    setIdentityServerUrl: vi.fn(),
    getOpenIdToken: vi.fn().mockResolvedValue({ access_token: 'openid' }),
    registerWithIdentityServer: vi
      .fn()
      .mockResolvedValue({ access_token: 'is-token', token: 'is-token' }),
    getTerms: vi.fn().mockResolvedValue(options.terms ?? { policies: {} }),
    agreeToTerms: vi.fn().mockResolvedValue({}),
    getUserId: vi.fn(() => ALICE),
    generateClientSecret: vi.fn(() => 'secret'),
    identityHashedLookup: vi.fn().mockResolvedValue([]),
    requestEmailToken: vi.fn().mockResolvedValue({ sid: 'sid1' }),
    bindThreePid: vi.fn().mockResolvedValue({}),
    unbindThreePid: vi.fn().mockResolvedValue({
      id_server_unbind_result: 'success',
    }),
  };
  TestBed.configureTestingModule({
    providers: [
      IdentityServerService,
      MockProvider(MatrixClientService, {
        clientFor: vi.fn(() =>
          options.client === false ? null : (client as never),
        ),
      }),
    ],
  });
  return Object.assign(TestBed.inject(IdentityServerService), {
    fake: client,
    accountData,
  });
}

const TERMS = {
  policies: {
    privacy: {
      version: '1',
      fr: { name: 'Confidentialité', url: 'https://is.example/fr' },
      en: { name: 'Privacy', url: 'https://is.example/en' },
    },
    tos: { version: '2', de: { name: 'AGB', url: 'https://is.example/de' } },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('IdentityServerService.choice', () => {
  it('reads the account choice', async () => {
    const s = setup({ accountData: { 'm.identity_server': { base_url: IS } } });
    expect(await firstValueFrom(s.choice(ALICE))).toEqual({
      kind: 'set',
      url: IS,
      source: 'account',
    });
  });

  it('reads an explicit off', async () => {
    const s = setup({
      accountData: { 'm.identity_server': { base_url: null } },
    });
    expect(await firstValueFrom(s.choice(ALICE))).toEqual({ kind: 'off' });
  });

  it('falls back to well-known', async () => {
    const s = setup({
      wellKnown: { 'm.identity_server': { base_url: IS } },
    });
    expect(await firstValueFrom(s.choice(ALICE))).toEqual({
      kind: 'set',
      url: IS,
      source: 'well-known',
    });
  });

  it('ignores a non-https well-known', async () => {
    const s = setup({
      wellKnown: { 'm.identity_server': { base_url: 'http://is.example' } },
    });
    expect(await firstValueFrom(s.choice(ALICE))).toEqual({ kind: 'none' });
  });

  it('is none when nothing is stored or advertised', async () => {
    expect(await firstValueFrom(setup().choice(ALICE))).toEqual({
      kind: 'none',
    });
  });

  it('refuses without a client', async () => {
    expect(
      await firstValueFrom(setup({ client: false }).choice(ALICE)),
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
    expect(s.fake.setIdentityServerUrl).not.toHaveBeenCalled();
    expect(s.fake.setAccountData).not.toHaveBeenCalled();
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
    expect(s.fake.setAccountData).not.toHaveBeenCalled();
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

  it('makes no request for an unavailable account', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await firstValueFrom(setup({ client: false }).use(ALICE, IS)),
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
    expect(s.fake.setAccountData).toHaveBeenCalledWith('m.identity_server', {
      base_url: IS,
    });
  });

  it('turns off by writing a null base_url', async () => {
    const s = setup();
    expect(await firstValueFrom(s.turnOff(ALICE))).toEqual({ kind: 'saved' });
    expect(s.fake.setAccountData).toHaveBeenCalledWith('m.identity_server', {
      base_url: null,
    });
  });
});

describe('IdentityServerService terms', () => {
  it('is accepted when every policy url is recorded', async () => {
    const s = setup({
      terms: TERMS,
      accountData: {
        'm.accepted_terms': {
          accepted: ['https://is.example/en', 'https://is.example/de'],
        },
      },
    });
    expect(await firstValueFrom(s.terms(ALICE, IS))).toEqual({
      kind: 'accepted',
    });
    expect(s.fake.getTerms).toHaveBeenCalledWith(SERVICE_TYPES.IS, IS);
  });

  it('needs consent only for the missing policies, preferring en', async () => {
    const s = setup({
      terms: TERMS,
      accountData: {
        'm.accepted_terms': { accepted: ['https://is.example/de'] },
      },
    });
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
    const s = setup({
      terms: TERMS,
      accountData: {
        'm.accepted_terms': {
          accepted: ['https://is.example/fr', 'https://is.example/de'],
        },
      },
    });
    expect(await firstValueFrom(s.terms(ALICE, IS))).toEqual({
      kind: 'accepted',
    });
  });

  it('asks again for a new version served at a new url', async () => {
    const s = setup({
      terms: {
        policies: {
          privacy: {
            version: '2.0',
            en: { name: 'Privacy', url: 'https://is.example/privacy-2' },
          },
          tos: {
            version: '1',
            en: { name: 'ToS', url: 'https://is.example/tos' },
          },
        },
      },
      accountData: {
        'm.accepted_terms': {
          accepted: ['https://is.example/privacy-1', 'https://is.example/tos'],
        },
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
    const s = setup({
      terms: {
        policies: {
          noVersion: { en: { name: 'A', url: 'https://is.example/a' } },
          badUrl: {
            version: '1',
            en: { name: 'B', url: 'http://is.example/b' },
          },
          badName: {
            version: '1',
            en: { name: 3, url: 'https://is.example/c' },
          },
          good: {
            version: '1',
            en: { name: 'G', url: 'https://is.example/g' },
          },
        },
      },
    });
    expect(await firstValueFrom(s.terms(ALICE, IS))).toEqual({
      kind: 'needs-consent',
      policies: [
        { id: 'good', name: 'G', url: 'https://is.example/g', version: '1' },
      ],
    });
  });

  it('does not substring-match a string accepted value', async () => {
    const s = setup({
      terms: TERMS,
      accountData: {
        'm.accepted_terms': {
          accepted: 'https://is.example/en https://is.example/de',
        },
      },
    });
    expect(await firstValueFrom(s.terms(ALICE, IS))).toMatchObject({
      kind: 'needs-consent',
    });
  });

  it('agrees to terms and appends the urls', async () => {
    const s = setup({
      accountData: { 'm.accepted_terms': { accepted: ['https://old'] } },
    });
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
    expect(s.fake.agreeToTerms).toHaveBeenCalledWith(
      SERVICE_TYPES.IS,
      IS,
      'is-token',
      ['https://is.example/en'],
    );
    expect(s.accountData['m.accepted_terms']).toEqual({
      accepted: ['https://old', 'https://is.example/en'],
    });
  });
});

describe('IdentityServerService token', () => {
  const policies = [
    { id: 'p', name: 'P', url: 'https://is.example/p', version: '1' },
  ];

  it('is reused across calls', async () => {
    const s = setup();
    await firstValueFrom(s.acceptTerms(ALICE, IS, policies));
    await firstValueFrom(s.acceptTerms(ALICE, IS, policies));
    expect(s.fake.registerWithIdentityServer).toHaveBeenCalledTimes(1);
    expect(s.fake.setIdentityServerUrl).toHaveBeenCalledWith(IS);
  });

  it('shares one token between a url and its trailing-slash form', async () => {
    const s = setup();
    await firstValueFrom(s.acceptTerms(ALICE, IS, policies));
    await firstValueFrom(s.acceptTerms(ALICE, `${IS}/`, policies));
    expect(s.fake.registerWithIdentityServer).toHaveBeenCalledTimes(1);
    expect(s.fake.agreeToTerms.mock.calls[1][1]).toBe(IS);
  });

  it('is renewed once after a 401 and retried once', async () => {
    const s = setup();
    s.fake.agreeToTerms
      .mockRejectedValueOnce(unauthorized())
      .mockResolvedValue({});
    expect(await firstValueFrom(s.acceptTerms(ALICE, IS, policies))).toEqual({
      kind: 'accepted',
    });
    expect(s.fake.registerWithIdentityServer).toHaveBeenCalledTimes(2);
    expect(s.fake.agreeToTerms).toHaveBeenCalledTimes(2);
  });

  it('refuses after a second 401', async () => {
    const s = setup();
    s.fake.agreeToTerms.mockRejectedValue(unauthorized());
    expect(await firstValueFrom(s.acceptTerms(ALICE, IS, policies))).toEqual({
      kind: 'refused',
      reason: 'failed',
    });
    expect(s.fake.registerWithIdentityServer).toHaveBeenCalledTimes(2);
    expect(s.fake.agreeToTerms).toHaveBeenCalledTimes(2);
  });

  it('logs nothing', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const s = setup();
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
    s.fake.identityHashedLookup.mockResolvedValue([
      { address: 'a@x.org', mxid: ALICE },
      { address: 'b@x.org', mxid: '@bob:example.org' },
    ]);
    const result = await firstValueFrom(
      s.findable(ALICE, IS, ['a@x.org', 'b@x.org', 'c@x.org']),
    );
    expect(result).toEqual({ kind: 'loaded', published: new Set(['a@x.org']) });
    expect(s.fake.identityHashedLookup).toHaveBeenCalledWith(
      [
        ['a@x.org', 'email'],
        ['b@x.org', 'email'],
        ['c@x.org', 'email'],
      ],
      'is-token',
    );
  });

  it('refuses on failure', async () => {
    const s = setup();
    s.fake.identityHashedLookup.mockRejectedValue(new Error('x'));
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
      await firstValueFrom(s.sendPublishLink(ALICE, IS, 'a@x.org')),
    ).toEqual({ kind: 'sent', pending: PENDING });
    expect(s.fake.requestEmailToken).toHaveBeenCalledWith(
      'a@x.org',
      'secret',
      1,
      undefined,
      'is-token',
    );
  });

  it('resends with the same secret and a higher attempt', async () => {
    const s = setup();
    expect(await firstValueFrom(s.resendPublishLink(PENDING))).toEqual({
      kind: 'sent',
      pending: { ...PENDING, sendAttempt: 2 },
    });
    expect(s.fake.requestEmailToken).toHaveBeenCalledWith(
      'a@x.org',
      'secret',
      2,
      undefined,
      'is-token',
    );
  });

  it('binds with the host only', async () => {
    const s = setup();
    expect(await firstValueFrom(s.publish(PENDING))).toEqual({
      kind: 'published',
    });
    expect(s.fake.bindThreePid).toHaveBeenCalledWith({
      sid: 'sid1',
      client_secret: 'secret',
      id_server: 'is.example',
      id_access_token: 'is-token',
    });
  });

  it('reports not-verified before the link is opened', async () => {
    const s = setup();
    s.fake.bindThreePid.mockRejectedValue(
      new MatrixError(
        {
          errcode: 'M_SESSION_NOT_VALIDATED',
          error: 'This validation session has not yet been completed',
        },
        400,
      ),
    );
    expect(await firstValueFrom(s.publish(PENDING))).toEqual({
      kind: 'not-verified',
      pending: PENDING,
    });
  });

  it('refuses other errors', async () => {
    const s = setup();
    s.fake.bindThreePid.mockRejectedValue(
      new MatrixError({ errcode: 'M_UNKNOWN', error: 'boom' }, 500),
    );
    expect(await firstValueFrom(s.publish(PENDING))).toEqual({
      kind: 'refused',
      reason: 'failed',
    });
  });
});

describe('IdentityServerService unpublish', () => {
  it('unbinds against the given server', async () => {
    const s = setup();
    expect(await firstValueFrom(s.unpublish(ALICE, IS, 'a@x.org'))).toEqual({
      kind: 'unpublished',
    });
    expect(s.fake.setIdentityServerUrl).toHaveBeenCalledWith(IS);
    expect(s.fake.unbindThreePid).toHaveBeenCalledWith('email', 'a@x.org');
  });

  it('treats a no-support server as unpublished', async () => {
    const s = setup();
    s.fake.unbindThreePid.mockResolvedValue({
      id_server_unbind_result: 'no-support',
    });
    expect(await firstValueFrom(s.unpublish(ALICE, IS, 'a@x.org'))).toEqual({
      kind: 'unpublished',
    });
  });

  it('unpublishAll of nothing unpublishes nothing', async () => {
    const s = setup();
    expect(await firstValueFrom(s.unpublishAll(ALICE, IS, []))).toEqual({
      kind: 'unpublished',
    });
    expect(s.fake.unbindThreePid).not.toHaveBeenCalled();
  });

  it('unpublishAll stops at the first refusal and emits it', async () => {
    const s = setup();
    s.fake.unbindThreePid
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('x'));
    expect(
      await firstValueFrom(s.unpublishAll(ALICE, IS, ['a', 'b', 'c'])),
    ).toEqual({ kind: 'refused', reason: 'failed' });
    expect(s.fake.unbindThreePid).toHaveBeenCalledTimes(2);
  });

  it('unpublishAll unpublishes every address in order', async () => {
    const s = setup();
    expect(await firstValueFrom(s.unpublishAll(ALICE, IS, ['a', 'b']))).toEqual(
      { kind: 'unpublished' },
    );
    expect(s.fake.unbindThreePid.mock.calls.map((c) => c[1])).toEqual([
      'a',
      'b',
    ]);
  });
});
