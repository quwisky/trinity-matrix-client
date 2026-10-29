import { createHash } from 'node:crypto';
import { EngineRequestError } from '@trinity/util/matrix';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agreeToTerms,
  getTerms,
  hashedLookup,
  newClientSecret,
  registerWithIdentityServer,
  requestEmailToken,
} from './identity-server-http';

const IS = 'https://is.example';
const V2 = `${IS}/_matrix/identity/v2`;
const TOKEN = 'is-token-secret';

// Answers recorded from Sydent 2.6.1 (the e2e harness's identity server).
const SYDENT = {
  terms: {
    policies: {
      privacy_policy: {
        version: '1.0',
        en: {
          name: 'Trinity e2e privacy policy',
          url: 'https://localhost:8452/trinity-e2e-privacy.html',
        },
      },
    },
  },
  register: { access_token: TOKEN, token: TOKEN },
  hashDetails: { algorithms: ['sha256', 'none'], lookup_pepper: 'iOHzN' },
  requestToken: { sid: '86943854' },
  termsNotSigned: { errcode: 'M_TERMS_NOT_SIGNED', error: 'Terms not signed' },
  unauthorized: { errcode: 'M_UNAUTHORIZED', error: 'Unauthorized' },
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

/** Stubs fetch with one answer per request, in order, and records the requests. */
function answer(
  ...answers: (readonly [number, unknown] | Error | DOMException)[]
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      calls.push({
        url,
        method: init.method ?? 'GET',
        authorization: headers.get('Authorization'),
        body:
          init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      const next = answers.shift();
      if (!next) throw new Error('unexpected request');
      if (!Array.isArray(next)) throw next;
      return new Response(JSON.stringify(next[1]), { status: next[0] });
    }),
  );
  return calls;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('base64url');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registerWithIdentityServer', () => {
  it('trades the OpenID token for the identity access token', async () => {
    const calls = answer([200, SYDENT.register]);

    const token = await registerWithIdentityServer(IS, {
      accessToken: 'openid',
      tokenType: 'Bearer',
      matrixServerName: 'example.org',
      expiresIn: 3600,
    });

    expect(token).toBe(TOKEN);
    expect(calls).toEqual([
      {
        url: `${V2}/account/register`,
        method: 'POST',
        authorization: null,
        body: {
          access_token: 'openid',
          token_type: 'Bearer',
          matrix_server_name: 'example.org',
          expires_in: 3600,
        },
      },
    ]);
  });

  it('reads an answer that names the token access_token only', async () => {
    answer([200, { access_token: TOKEN }]);

    expect(
      await registerWithIdentityServer(IS, {
        accessToken: 'openid',
        tokenType: 'Bearer',
        matrixServerName: 'example.org',
        expiresIn: 3600,
      }),
    ).toBe(TOKEN);
  });
});

describe('terms', () => {
  it('reads the policies without a token', async () => {
    const calls = answer([200, SYDENT.terms]);

    expect(await getTerms(IS)).toEqual(SYDENT.terms.policies);
    expect(calls[0]).toMatchObject({
      url: `${V2}/terms`,
      method: 'GET',
      authorization: null,
    });
  });

  it('refuses an answer without a policies object', async () => {
    answer([200, { policies: { privacy_policy: null } }]);

    await expect(getTerms(IS)).rejects.toThrow();
  });

  it('agrees to the given urls with the token', async () => {
    const calls = answer([200, {}]);

    await agreeToTerms(IS, TOKEN, ['https://is.example/en']);

    expect(calls).toEqual([
      {
        url: `${V2}/terms`,
        method: 'POST',
        authorization: `Bearer ${TOKEN}`,
        body: { user_accepts: ['https://is.example/en'] },
      },
    ]);
  });
});

describe('requestEmailToken', () => {
  it('asks the identity server to mail the link and returns the session', async () => {
    const calls = answer([200, SYDENT.requestToken]);

    expect(
      await requestEmailToken(IS, TOKEN, {
        email: 'a@x.org',
        clientSecret: 'secret',
        sendAttempt: 2,
      }),
    ).toBe('86943854');
    expect(calls).toEqual([
      {
        url: `${V2}/validate/email/requestToken`,
        method: 'POST',
        authorization: `Bearer ${TOKEN}`,
        body: { email: 'a@x.org', client_secret: 'secret', send_attempt: 2 },
      },
    ]);
  });
});

describe('hashedLookup', () => {
  it('sends only sha256 hashes with the pepper and maps answers back to the asked address', async () => {
    const hash = sha256('a@x.org email iOHzN');
    const calls = answer(
      [200, SYDENT.hashDetails],
      [200, { mappings: { [hash]: '@alice:example.org' } }],
    );

    expect(await hashedLookup(IS, TOKEN, ['A@x.org', 'b@x.org'])).toEqual([
      { address: 'A@x.org', mxid: '@alice:example.org' },
    ]);
    expect(calls.map(({ url, authorization }) => [url, authorization])).toEqual(
      [
        [`${V2}/hash_details`, `Bearer ${TOKEN}`],
        [`${V2}/lookup`, `Bearer ${TOKEN}`],
      ],
    );
    expect(calls[1].body).toEqual({
      addresses: [hash, sha256('b@x.org email iOHzN')],
      algorithm: 'sha256',
      pepper: 'iOHzN',
    });
    expect(JSON.stringify(calls)).not.toContain('x.org');
  });

  it('never looks up when the server does not offer sha256', async () => {
    const calls = answer([
      200,
      { algorithms: ['none'], lookup_pepper: 'iOHzN' },
    ]);

    await expect(hashedLookup(IS, TOKEN, ['a@x.org'])).rejects.toThrow();
    expect(calls.map(({ url }) => url)).toEqual([`${V2}/hash_details`]);
  });

  it('treats a missing mappings object as no matches', async () => {
    answer([200, SYDENT.hashDetails], [200, {}]);

    expect(await hashedLookup(IS, TOKEN, ['a@x.org'])).toEqual([]);
  });

  it('refuses an answer for an address it did not ask about', async () => {
    answer(
      [200, SYDENT.hashDetails],
      [200, { mappings: { other: '@bob:example.org' } }],
    );

    await expect(hashedLookup(IS, TOKEN, ['a@x.org'])).rejects.toThrow();
  });
});

describe('failures', () => {
  async function failureOf(promise: Promise<unknown>) {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EngineRequestError);
    return error as EngineRequestError;
  }

  it('carries the status and errcode of a refusal, and no request detail', async () => {
    answer([403, SYDENT.termsNotSigned]);

    const error = await failureOf(hashedLookup(IS, TOKEN, ['a@x.org']));

    expect(error.failure).toEqual({
      kind: 'http',
      code: 'request-failed',
      diagnostic: {
        kind: 'http',
        httpStatus: 403,
        errcode: 'M_TERMS_NOT_SIGNED',
      },
    });
    expect(`${error.message} ${JSON.stringify(error.failure)}`).not.toMatch(
      /a@x\.org|is-token|is\.example/,
    );
  });

  it('reports an unauthorized token as a 401', async () => {
    answer([401, SYDENT.unauthorized]);

    const error = await failureOf(agreeToTerms(IS, TOKEN, []));

    expect(error.failure.diagnostic).toEqual({
      kind: 'http',
      httpStatus: 401,
      errcode: 'M_UNAUTHORIZED',
    });
  });

  it('reports a rate limit with its delay', async () => {
    answer([429, { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 2000 }]);

    const error = await failureOf(getTerms(IS));

    expect(error.failure).toMatchObject({
      kind: 'rate-limit',
      diagnostic: { httpStatus: 429, retryAfterMs: 2000 },
    });
  });

  it('drops a rate-limit delay longer than a day', async () => {
    answer([
      429,
      { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 24 * 60 * 60 * 1000 + 1 },
    ]);

    const error = await failureOf(getTerms(IS));

    expect(error.failure.diagnostic).toEqual({
      kind: 'rate-limit',
      httpStatus: 429,
      errcode: 'M_LIMIT_EXCEEDED',
    });
  });

  it('drops an errcode that is not one', async () => {
    answer([400, { errcode: 'mail a@x.org' }]);

    const error = await failureOf(getTerms(IS));

    expect(error.failure.diagnostic).toEqual({ kind: 'http', httpStatus: 400 });
  });

  it('reports an unreachable server as a network failure', async () => {
    answer(new TypeError('Failed to fetch'));

    expect((await failureOf(getTerms(IS))).failure.kind).toBe('network');
  });

  it('reports a timeout', async () => {
    answer(new DOMException('timed out', 'TimeoutError'));

    expect((await failureOf(getTerms(IS))).failure.kind).toBe('timeout');
  });
});

describe('newClientSecret', () => {
  it('is fresh each time and uses only characters the spec allows', () => {
    const secret = newClientSecret();

    // 192 random bits as hex, no less than js-sdk's 32 alphanumerics.
    expect(secret).toMatch(/^[0-9a-f]{48}$/);
    expect(newClientSecret()).not.toBe(secret);
  });
});
