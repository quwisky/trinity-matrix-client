import type { ValidatedAuthMetadata } from 'matrix-js-sdk';
import {
  OIDC_PROVIDER_MISMATCH,
  verifiedDeviceGrantMetadata,
  verifiedEndpoints,
} from './oidc-issuer-discovery';

const METADATA = {
  issuer: 'https://op.example/',
  authorization_endpoint: 'https://op.example/authorize',
  token_endpoint: 'https://op.example/token',
  revocation_endpoint: 'https://op.example/revoke',
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
} as unknown as ValidatedAuthMetadata;

const RFC8414_DISCOVERY =
  'https://op.example/.well-known/oauth-authorization-server';

/** Serve `document` as the issuer's RFC 8414 document; anything else answers 404. */
function issuerServes(document: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === RFC8414_DISCOVERY && document !== null
        ? new Response(JSON.stringify(document))
        : new Response('{}', { status: 404 }),
    ),
  );
}

describe('verifiedEndpoints', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('when the issuer publishes no document', () => {
    beforeEach(() => issuerServes(null));

    it("uses endpoints on the issuer's own origin", async () => {
      await expect(verifiedEndpoints(METADATA)).resolves.toEqual({
        tokenEndpoint: METADATA.token_endpoint,
        revocationEndpoint: METADATA.revocation_endpoint,
      });
    });

    it.each([
      ['host', 'https://hs.example/token'],
      ['port', 'https://op.example:8443/token'],
      ['scheme', 'http://op.example/token'],
    ])(
      "refuses a token endpoint on another %s than the issuer's",
      async (_, tokenEndpoint) => {
        await expect(
          verifiedEndpoints({ ...METADATA, token_endpoint: tokenEndpoint }),
        ).rejects.toThrow(OIDC_PROVIDER_MISMATCH);
      },
    );

    it("leaves out a revocation endpoint on another origin than the issuer's", async () => {
      await expect(
        verifiedEndpoints({
          ...METADATA,
          revocation_endpoint: 'https://hs.example/revoke',
        }),
      ).resolves.toEqual({ tokenEndpoint: METADATA.token_endpoint });
    });
  });

  it("leaves out a revocation endpoint the document omits and that is on another origin than the issuer's", async () => {
    const { revocation_endpoint: _omitted, ...document } = METADATA;
    issuerServes(document);

    await expect(
      verifiedEndpoints({
        ...METADATA,
        revocation_endpoint: 'https://hs.example/revoke',
      }),
    ).resolves.toEqual({ tokenEndpoint: METADATA.token_endpoint });
  });

  it('keeps endpoints on other origins that the document confirms', async () => {
    const elsewhere = {
      ...METADATA,
      authorization_endpoint: 'https://login.example/authorize',
      token_endpoint: 'https://login.example/token',
      revocation_endpoint: 'https://login.example/revoke',
    };
    issuerServes(elsewhere);

    await expect(verifiedEndpoints(elsewhere)).resolves.toEqual({
      tokenEndpoint: elsewhere.token_endpoint,
      revocationEndpoint: elsewhere.revocation_endpoint,
    });
  });

  it("refuses endpoints whose origin is opaque, even when it is the issuer's", async () => {
    issuerServes(null);

    await expect(
      verifiedEndpoints({
        ...METADATA,
        issuer: 'urn:op',
        token_endpoint: 'urn:op:token',
      }),
    ).rejects.toThrow(OIDC_PROVIDER_MISMATCH);
  });
});

describe('verifiedDeviceGrantMetadata', () => {
  const DEVICE = {
    ...METADATA,
    device_authorization_endpoint: 'https://op.example/device',
  } as ValidatedAuthMetadata;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses device and token endpoints on the issuer's own origin when it publishes no document", async () => {
    issuerServes(null);

    await expect(verifiedDeviceGrantMetadata(DEVICE)).resolves.toEqual(DEVICE);
  });

  it('uses the endpoints the document confirms', async () => {
    const elsewhere = {
      ...DEVICE,
      token_endpoint: 'https://login.example/token',
      device_authorization_endpoint: 'https://login.example/device',
    };
    issuerServes(elsewhere);

    await expect(verifiedDeviceGrantMetadata(elsewhere)).resolves.toEqual(
      elsewhere,
    );
  });

  it.each([
    [
      "a token endpoint on another origin than the issuer's",
      { token_endpoint: 'https://hs.example/token' },
    ],
    [
      "a device endpoint on another origin than the issuer's",
      { device_authorization_endpoint: 'https://hs.example/device' },
    ],
    ['no device endpoint', { device_authorization_endpoint: undefined }],
  ])('refuses %s when the issuer publishes no document', async (_, change) => {
    issuerServes(null);

    await expect(
      verifiedDeviceGrantMetadata({ ...DEVICE, ...change }),
    ).rejects.toThrow(OIDC_PROVIDER_MISMATCH);
  });

  it('refuses a device endpoint the document names differently', async () => {
    issuerServes({
      ...DEVICE,
      device_authorization_endpoint: 'https://op.example/other-device',
    });

    await expect(verifiedDeviceGrantMetadata(DEVICE)).rejects.toThrow(
      OIDC_PROVIDER_MISMATCH,
    );
  });

  it("refuses a device endpoint the document omits that is on another origin than the issuer's", async () => {
    issuerServes(METADATA);

    await expect(
      verifiedDeviceGrantMetadata({
        ...DEVICE,
        device_authorization_endpoint: 'https://hs.example/device',
      }),
    ).rejects.toThrow(OIDC_PROVIDER_MISMATCH);
  });
});
