import { Injector } from '@angular/core';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { MatrixError } from '@trinity/util/matrix';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { JsSdkContactAddressesEngine } from './js-sdk-contact-addresses-engine';

const ME = '@me:example.org';

// What the Synapse contract cannot reach: a well-known identity server, malformed account
// data, a disabled 3PID capability and the raw unbind request.
function setup(accountData: Record<string, unknown> = {}) {
  const client = {
    getAccountDataFromServer: vi.fn(
      async (type: string) => accountData[type] ?? null,
    ),
    getClientWellKnown: vi.fn(() => ({
      'm.identity_server': { base_url: 'https://is.example' },
    })),
    getThreePids: vi.fn().mockResolvedValue({
      threepids: [{ medium: 'msisdn', address: '15550000', validated_at: 1 }],
    }),
    getCapabilities: vi
      .fn()
      .mockResolvedValue({ 'm.3pid_changes': { enabled: false } }),
    setIdentityServerUrl: vi.fn(),
    bindThreePid: vi.fn(),
    http: {
      authedRequest: vi
        .fn()
        .mockResolvedValue({ id_server_unbind_result: 'no-support' }),
    },
  };
  const engine = Injector.create({
    providers: [
      {
        provide: JS_SDK_CLIENTS,
        useValue: { clientFor: (id: string) => (id === ME ? client : null) },
      },
      JsSdkContactAddressesEngine,
    ],
  }).get(JsSdkContactAddressesEngine);
  return { engine, client };
}

describe('JsSdkContactAddressesEngine', () => {
  it('reads the well-known identity server beside the account data', async () => {
    const { engine } = setup({ 'm.identity_server': {} });

    expect(await firstValueFrom(engine.identityServerSetting(ME))).toEqual({
      ok: true,
      value: { account: { baseUrl: null }, wellKnown: 'https://is.example' },
    });
  });

  it('keeps only string urls of the accepted terms', async () => {
    const { engine } = setup({
      'm.accepted_terms': { accepted: ['https://a', 3, null] },
    });
    const notAList = setup({
      'm.accepted_terms': { accepted: 'https://a https://b' },
    });

    expect(await firstValueFrom(engine.acceptedTerms(ME))).toEqual({
      ok: true,
      value: ['https://a'],
    });
    expect(await firstValueFrom(notAList.engine.acceptedTerms(ME))).toEqual({
      ok: true,
      value: [],
    });
  });

  it('passes every medium through and reads a disabled 3PID capability', async () => {
    const { engine } = setup();

    expect(await firstValueFrom(engine.threePids(ME))).toEqual({
      ok: true,
      value: {
        addresses: [{ medium: 'msisdn', address: '15550000' }],
        canChange: false,
      },
    });
  });

  it('reads a missing 3PID capability as changeable', async () => {
    const { engine, client } = setup();
    client.getCapabilities.mockResolvedValue({});

    expect(await firstValueFrom(engine.threePids(ME))).toMatchObject({
      ok: true,
      value: { canChange: true },
    });
  });

  it('unbinds at the given server without touching client state', async () => {
    const { engine, client } = setup();

    expect(
      await firstValueFrom(
        engine.unbindThreePid(ME, {
          medium: 'email',
          address: 'a@x.org',
          idServer: 'is.example',
        }),
      ),
    ).toEqual({ ok: true, value: 'no-support' });
    expect(client.http.authedRequest).toHaveBeenCalledWith(
      'POST',
      '/account/3pid/unbind',
      undefined,
      { medium: 'email', address: 'a@x.org', id_server: 'is.example' },
    );
    expect(client.setIdentityServerUrl).not.toHaveBeenCalled();
  });

  it('carries the errcode of a refused bind', async () => {
    const { engine, client } = setup();
    client.bindThreePid.mockRejectedValue(
      new MatrixError({ errcode: 'M_SESSION_NOT_VALIDATED', error: 'no' }, 400),
    );

    expect(
      await firstValueFrom(
        engine.bindThreePid(ME, {
          sid: 's',
          clientSecret: 'c',
          idServer: 'is.example',
          idAccessToken: 't',
        }),
      ),
    ).toEqual({
      ok: false,
      failure: {
        kind: 'http',
        code: 'request-failed',
        diagnostic: {
          kind: 'http',
          httpStatus: 400,
          errcode: 'M_SESSION_NOT_VALIDATED',
        },
      },
    });
  });
});
