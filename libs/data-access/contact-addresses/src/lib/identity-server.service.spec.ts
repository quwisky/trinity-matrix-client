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

afterEach(() => vi.unstubAllGlobals());

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
