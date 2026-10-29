import { MatrixError, createClient } from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import { uiaFallbackUrl } from '@trinity/util/matrix';
import { jsSdkUia, uiaChallengeOf } from './uia';

describe('uiaChallengeOf', () => {
  it('reads the flows, completed stages and session of a UIA 401', () => {
    const error = new MatrixError(
      {
        flows: [{ stages: ['m.login.password', 'm.login.terms'] }],
        completed: ['m.login.password'],
        session: 's1',
        params: {},
      },
      401,
    );

    expect(uiaChallengeOf(error)).toEqual({
      flows: [{ stages: ['m.login.password', 'm.login.terms'] }],
      completed: ['m.login.password'],
      session: 's1',
    });
  });

  it('is null for a failure that carries no flows', () => {
    expect(
      uiaChallengeOf(new MatrixError({ errcode: 'M_FORBIDDEN' }, 403)),
    ).toBeNull();
    // A plain 401 is a dead token or an unconfirmed reset, not a challenge.
    expect(
      uiaChallengeOf(new MatrixError({ errcode: 'M_UNKNOWN_TOKEN' }, 401)),
    ).toBeNull();
    expect(uiaChallengeOf(new MatrixError({}, 401))).toBeNull();
    expect(uiaChallengeOf(new Error('network down'))).toBeNull();
  });

  it('is null for an error body that is not an object', () => {
    for (const body of [0, '', false, 'Bad Gateway']) {
      const error = new MatrixError({}, 502);
      (error as { data: unknown }).data = body;
      expect(uiaChallengeOf(error)).toBeNull();
    }
  });

  it('keeps only well-formed flows, stages and session', () => {
    const malformed = new MatrixError(
      { flows: 'password', completed: 'm.login.password', session: 7 },
      401,
    );
    expect(uiaChallengeOf(malformed)).toEqual({ flows: [], completed: [] });

    const partly = new MatrixError(
      { flows: [{ stages: ['m.login.password', 3] }, {}, null], session: 's' },
      401,
    );
    expect(uiaChallengeOf(partly)).toEqual({
      flows: [{ stages: ['m.login.password'] }, { stages: [] }, { stages: [] }],
      completed: [],
      session: 's',
    });
  });
});

describe('jsSdkUia', () => {
  it('probes without auth and passes a result through', async () => {
    const request = vi.fn().mockResolvedValue('ok');

    await expect(jsSdkUia(request)(null)).resolves.toEqual({
      kind: 'done',
      result: 'ok',
    });
    expect(request).toHaveBeenCalledWith(null);
  });

  it('sends the auth as the request dict', async () => {
    const request = vi.fn().mockResolvedValue('ok');
    const auth = { session: 's1' };

    await jsSdkUia(request)(auth);
    expect(request).toHaveBeenCalledWith(auth);
  });

  it('rethrows a plain 401 instead of reading it as a challenge', async () => {
    const dead = new MatrixError({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    const request = vi.fn().mockRejectedValue(dead);

    await expect(jsSdkUia(request)(null)).rejects.toBe(dead);
  });

  it('turns a UIA 401 into its challenge', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(
        new MatrixError(
          { flows: [{ stages: ['m.login.password'] }], session: 's1' },
          401,
        ),
      );

    await expect(jsSdkUia(request)(null)).resolves.toEqual({
      kind: 'uia-required',
      challenge: {
        flows: [{ stages: ['m.login.password'] }],
        completed: [],
        session: 's1',
      },
    });
  });

  it('rethrows any other failure', async () => {
    const failure = new MatrixError({ errcode: 'M_LIMIT_EXCEEDED' }, 429);

    await expect(
      jsSdkUia(vi.fn().mockRejectedValue(failure))(null),
    ).rejects.toBe(failure);
  });
});

describe('uiaFallbackUrl', () => {
  it.each([
    ['https://hs.example', 'm.login.sso', 's1'],
    ['https://hs.example/base/', 'm.login.recaptcha', 'a b/c&d'],
  ])('builds the URL the SDK builds for %s', (baseUrl, stage, session) => {
    expect(uiaFallbackUrl(baseUrl, stage, session)).toBe(
      createClient({ baseUrl }).getFallbackAuthUrl(stage, session),
    );
  });
});
