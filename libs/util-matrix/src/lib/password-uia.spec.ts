import { MatrixError } from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  UiaCancelledError,
  UiaUnsupportedError,
  assertPasswordUiaAvailable,
  runPasswordUia,
} from './password-uia';

const USER = '@me:hs';

/** A UIA 401 with the given session + offered stages. */
function uia(
  session: string,
  stages: string[] = ['m.login.password'],
  completed?: string[],
): MatrixError {
  return new MatrixError(
    { flows: [{ stages }], session, ...(completed ? { completed } : {}) },
    401,
  );
}

describe('runPasswordUia', () => {
  it('returns the result without prompting when no auth is required', async () => {
    const makeRequest = vi.fn().mockResolvedValue('ok');
    const prompt = vi.fn();

    await expect(runPasswordUia(makeRequest, prompt, USER)).resolves.toBe('ok');
    expect(makeRequest).toHaveBeenCalledWith(null);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('submits the password against the returned session', async () => {
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(uia('s1'))
      .mockResolvedValueOnce('done');
    const prompt = vi.fn().mockResolvedValue('pw');

    await expect(runPasswordUia(makeRequest, prompt, USER)).resolves.toBe(
      'done',
    );
    expect(makeRequest.mock.calls[1][0]).toMatchObject({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: USER },
      password: 'pw',
      session: 's1',
    });
  });

  it('re-prompts after a wrong password, then succeeds', async () => {
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(uia('s1'))
      .mockRejectedValueOnce(uia('s2'))
      .mockResolvedValueOnce('done');
    const prompt = vi
      .fn()
      .mockResolvedValueOnce('wrong')
      .mockResolvedValueOnce('right');

    await expect(runPasswordUia(makeRequest, prompt, USER)).resolves.toBe(
      'done',
    );
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(makeRequest.mock.calls[2][0]).toMatchObject({
      password: 'right',
      session: 's2', // threaded from the failed attempt
    });
  });

  it('throws UiaCancelledError when the prompt is cancelled', async () => {
    const makeRequest = vi.fn().mockRejectedValueOnce(uia('s1'));
    const prompt = vi.fn().mockResolvedValue(null);

    await expect(
      runPasswordUia(makeRequest, prompt, USER),
    ).rejects.toBeInstanceOf(UiaCancelledError);
  });

  it('gives up after too many wrong passwords', async () => {
    const makeRequest = vi.fn().mockRejectedValue(uia('s'));
    const prompt = vi.fn().mockResolvedValue('nope');

    await expect(runPasswordUia(makeRequest, prompt, USER)).rejects.toThrow(
      /too many/i,
    );
    expect(prompt).toHaveBeenCalledTimes(3);
  });

  it('bails clearly when no password stage is offered (e.g. SSO-only)', async () => {
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(uia('s1', ['m.login.sso']));
    const prompt = vi.fn();

    await expect(runPasswordUia(makeRequest, prompt, USER)).rejects.toThrow(
      /additional verification/i,
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  it('rethrows a non-UIA failure without prompting', async () => {
    const makeRequest = vi
      .fn()
      .mockRejectedValue(new MatrixError({ errcode: 'M_LIMIT_EXCEEDED' }, 429));
    const prompt = vi.fn();

    await expect(
      runPasswordUia(makeRequest, prompt, USER),
    ).rejects.toBeInstanceOf(MatrixError);
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe('assertPasswordUiaAvailable', () => {
  // The contract is deliberately narrow: refuse ONLY on a UIA challenge that offers no
  // password stage. Everything else — including the probe failing outright — has to pass
  // through, because this guards an action it must never be the reason for failing.
  it('refuses when the server offers only a non-password stage', async () => {
    const probe = vi.fn().mockRejectedValue(uia('s', ['m.login.sso']));

    await expect(assertPasswordUiaAvailable(probe)).rejects.toBeInstanceOf(
      UiaUnsupportedError,
    );
  });

  it('refuses on the OIDC-native cross-signing-reset challenge', async () => {
    // MSC3861 homeservers answer with this shape rather than a login stage.
    const probe = vi
      .fn()
      .mockRejectedValue(uia('s', ['org.matrix.cross_signing_reset']));

    await expect(assertPasswordUiaAvailable(probe)).rejects.toBeInstanceOf(
      UiaUnsupportedError,
    );
  });

  it('allows a password stage through', async () => {
    const probe = vi.fn().mockRejectedValue(uia('s'));

    await expect(assertPasswordUiaAvailable(probe)).resolves.toBeUndefined();
  });

  it('allows a probe that is not challenged at all', async () => {
    const probe = vi.fn().mockResolvedValue({});

    await expect(assertPasswordUiaAvailable(probe)).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledOnce();
  });

  it('stays silent when the probe fails for an unrelated reason', async () => {
    // A dropped connection, or a server that does not gate this endpoint, must leave the
    // caller exactly where it was rather than becoming a new way to fail.
    const probe = vi.fn().mockRejectedValue(new Error('network down'));

    await expect(assertPasswordUiaAvailable(probe)).resolves.toBeUndefined();
  });

  it('stays silent on a non-UIA MatrixError', async () => {
    const probe = vi
      .fn()
      .mockRejectedValue(new MatrixError({ errcode: 'M_UNKNOWN' }, 500));

    await expect(assertPasswordUiaAvailable(probe)).resolves.toBeUndefined();
  });

  it('allows an empty flow set through rather than guessing', async () => {
    const probe = vi
      .fn()
      .mockRejectedValue(new MatrixError({ flows: [], session: 's' }, 401));

    await expect(assertPasswordUiaAvailable(probe)).resolves.toBeUndefined();
  });

  it('refuses when the only password stage is already completed', async () => {
    // A multi-stage flow past the password is not something Trinity can finish here.
    const probe = vi
      .fn()
      .mockRejectedValue(uia('s', ['m.login.password'], ['m.login.password']));

    await expect(assertPasswordUiaAvailable(probe)).rejects.toBeInstanceOf(
      UiaUnsupportedError,
    );
  });
});
