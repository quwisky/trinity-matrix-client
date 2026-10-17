import { MatrixError } from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  UiaAttemptsExceededError,
  UiaCancelledError,
  UiaUnsupportedError,
  completePasswordUia,
  driveUia,
  isUiaRefusal,
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

    await expect(
      runPasswordUia(makeRequest, prompt, USER),
    ).rejects.toBeInstanceOf(UiaAttemptsExceededError);
    expect(prompt).toHaveBeenCalledTimes(3);
  });

  it('does not spend a user attempt on a replayed password the server rejects', async () => {
    // The caller replays a password an earlier request already had accepted, so the user
    // is not asked twice. When it is rejected anyway (it changed between the requests),
    // the rejection is the *replay's*, and the human must still get all three tries.
    const makeRequest = vi.fn().mockRejectedValue(uia('s'));
    const prompt = vi.fn().mockResolvedValue('nope');

    await expect(
      runPasswordUia(makeRequest, prompt, USER, { replayedAttempts: 1 }),
    ).rejects.toBeInstanceOf(UiaAttemptsExceededError);
    expect(prompt).toHaveBeenCalledTimes(4); // the replay, then three of the user's own
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

describe('completePasswordUia', () => {
  // This is what an irreversible action authenticates with, so the distinction that
  // matters is "the user did not get in" (refuse, and destroy nothing) versus "the
  // request itself failed" (which the caller may choose to carry on past).
  it('reports the password the server accepted', async () => {
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(uia('s1'))
      .mockResolvedValueOnce('done');
    const prompt = vi.fn().mockResolvedValue('pw');

    await expect(completePasswordUia(makeRequest, prompt, USER)).resolves.toBe(
      'pw',
    );
    expect(makeRequest.mock.calls[1][0]).toMatchObject({
      type: 'm.login.password',
      password: 'pw',
      session: 's1',
    });
  });

  it('reports the last accepted password, not a rejected one', async () => {
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(uia('s1'))
      .mockRejectedValueOnce(uia('s2'))
      .mockResolvedValueOnce('done');
    const prompt = vi
      .fn()
      .mockResolvedValueOnce('wrong')
      .mockResolvedValueOnce('right');

    await expect(completePasswordUia(makeRequest, prompt, USER)).resolves.toBe(
      'right',
    );
  });

  it('reports null when the server asks for no auth at all', async () => {
    const makeRequest = vi.fn().mockResolvedValue({});
    const prompt = vi.fn();

    await expect(
      completePasswordUia(makeRequest, prompt, USER),
    ).resolves.toBeNull();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('refuses when the server offers only a non-password stage (SSO-only)', async () => {
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(uia('s', ['m.login.sso']));
    const prompt = vi.fn();

    await expect(
      completePasswordUia(makeRequest, prompt, USER),
    ).rejects.toBeInstanceOf(UiaUnsupportedError);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('refuses on the OIDC-native cross-signing-reset challenge', async () => {
    // MSC3861 homeservers answer with this shape rather than a login stage.
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(uia('s', ['org.matrix.cross_signing_reset']));

    await expect(
      completePasswordUia(makeRequest, vi.fn(), USER),
    ).rejects.toBeInstanceOf(UiaUnsupportedError);
  });

  it('refuses when the only password stage is already completed', async () => {
    // A multi-stage flow past the password is not something Trinity can finish here.
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(
        uia('s', ['m.login.password'], ['m.login.password']),
      );

    await expect(
      completePasswordUia(makeRequest, vi.fn(), USER),
    ).rejects.toBeInstanceOf(UiaUnsupportedError);
  });

  it('refuses when the user cancels the prompt', async () => {
    const makeRequest = vi.fn().mockRejectedValueOnce(uia('s1'));
    const prompt = vi.fn().mockResolvedValue(null);

    await expect(
      completePasswordUia(makeRequest, prompt, USER),
    ).rejects.toBeInstanceOf(UiaCancelledError);
    expect(makeRequest).toHaveBeenCalledTimes(1); // the probe only; nothing authenticated
  });

  it('rethrows the request failure when it is not a UIA verdict', async () => {
    const failure = new MatrixError({ errcode: 'M_UNKNOWN' }, 500);
    const makeRequest = vi.fn().mockRejectedValue(failure);

    await expect(completePasswordUia(makeRequest, vi.fn(), USER)).rejects.toBe(
      failure,
    );
  });

  it('attempts a password against an empty flow set rather than guessing', async () => {
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(new MatrixError({ flows: [], session: 's' }, 401))
      .mockResolvedValueOnce({});
    const prompt = vi.fn().mockResolvedValue('pw');

    await expect(completePasswordUia(makeRequest, prompt, USER)).resolves.toBe(
      'pw',
    );
  });
});

describe('isUiaRefusal', () => {
  it('is true for every way the user can fail to authenticate', () => {
    expect(isUiaRefusal(new UiaCancelledError())).toBe(true);
    expect(isUiaRefusal(new UiaUnsupportedError())).toBe(true);
    expect(isUiaRefusal(new UiaAttemptsExceededError())).toBe(true);
  });

  it('is false for a failure of the request itself', () => {
    expect(isUiaRefusal(new MatrixError({ errcode: 'M_UNKNOWN' }, 500))).toBe(
      false,
    );
    expect(isUiaRefusal(new Error('network down'))).toBe(false);
  });
});

/** A UIA 401 offering several flows. */
function uiaFlows(
  session: string,
  flows: string[][],
  completed: string[] = [],
): MatrixError {
  return new MatrixError(
    { flows: flows.map((stages) => ({ stages })), session, completed },
    401,
  );
}

describe('driveUia', () => {
  it('sends the probe without auth and returns when the server needs none', async () => {
    const makeRequest = vi.fn().mockResolvedValue('ok');

    await expect(
      driveUia(makeRequest, { password: { user: USER, prompt: vi.fn() } }),
    ).resolves.toEqual({ result: 'ok', password: null });
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(makeRequest).toHaveBeenCalledWith(null);
  });

  it('tells the password prompt when the previous password was rejected', async () => {
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(uia('s1'))
      .mockRejectedValueOnce(uia('s1'))
      .mockResolvedValueOnce('done');
    const prompt = vi
      .fn()
      .mockResolvedValueOnce('wrong')
      .mockResolvedValueOnce('right');

    await expect(
      driveUia(makeRequest, { password: { user: USER, prompt } }),
    ).resolves.toEqual({ result: 'done', password: 'right' });
    expect(prompt.mock.calls.map(([context]) => context)).toEqual([
      { rejected: false },
      { rejected: true },
    ]);
  });

  it('stops after three rejected passwords', async () => {
    const makeRequest = vi.fn().mockRejectedValue(uia('s'));
    const prompt = vi.fn().mockResolvedValue('nope');

    await expect(
      driveUia(makeRequest, { password: { user: USER, prompt } }),
    ).rejects.toBeInstanceOf(UiaAttemptsExceededError);
    expect(prompt).toHaveBeenCalledTimes(3);
  });

  it('completes a non-password stage through the fallback, retrying with the session only', async () => {
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(uia('s1', ['m.login.sso']))
      .mockResolvedValueOnce('done');
    const fallback = vi.fn().mockResolvedValue(true);

    await expect(driveUia(makeRequest, { fallback })).resolves.toEqual({
      result: 'done',
      password: null,
    });
    expect(fallback).toHaveBeenCalledWith({
      stage: 'm.login.sso',
      session: 's1',
      pending: false,
    });
    expect(makeRequest.mock.calls[1][0]).toEqual({ session: 's1' });
  });

  it('reports a fallback stage the server has not seen completed yet, as often as asked', async () => {
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(uia('s1', ['m.login.sso']))
      .mockRejectedValueOnce(uia('s1', ['m.login.sso']))
      .mockRejectedValueOnce(uia('s1', ['m.login.sso']))
      .mockRejectedValueOnce(uia('s1', ['m.login.sso']))
      .mockResolvedValueOnce('done');
    const fallback = vi.fn().mockResolvedValue(true);

    await expect(driveUia(makeRequest, { fallback })).resolves.toMatchObject({
      result: 'done',
    });
    expect(fallback.mock.calls.map(([step]) => step.pending)).toEqual([
      false,
      true,
      true,
      true,
    ]);
  });

  it('cancels when the fallback step is abandoned', async () => {
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(uia('s1', ['m.login.sso']));

    await expect(
      driveUia(makeRequest, { fallback: vi.fn().mockResolvedValue(false) }),
    ).rejects.toBeInstanceOf(UiaCancelledError);
    expect(makeRequest).toHaveBeenCalledTimes(1);
  });

  it('completes a multi-stage flow one stage at a time', async () => {
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(
        uiaFlows('s', [['m.login.password', 'm.login.terms']]),
      )
      .mockRejectedValueOnce(
        uiaFlows(
          's',
          [['m.login.password', 'm.login.terms']],
          ['m.login.password'],
        ),
      )
      .mockResolvedValueOnce('done');
    const prompt = vi.fn().mockResolvedValue('pw');
    const fallback = vi.fn().mockResolvedValue(true);

    await expect(
      driveUia(makeRequest, { password: { user: USER, prompt }, fallback }),
    ).resolves.toEqual({ result: 'done', password: 'pw' });
    expect(makeRequest.mock.calls[1][0]).toMatchObject({
      type: 'm.login.password',
      session: 's',
    });
    expect(fallback).toHaveBeenCalledWith({
      stage: 'm.login.terms',
      session: 's',
      pending: false,
    });
    expect(makeRequest.mock.calls[2][0]).toEqual({ session: 's' });
  });

  it('moves on after a correct third password instead of reporting too many', async () => {
    const flows = [['m.login.password', 'm.login.terms']];
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(uiaFlows('s', flows))
      .mockRejectedValueOnce(uiaFlows('s', flows))
      .mockRejectedValueOnce(uiaFlows('s', flows))
      .mockRejectedValueOnce(uiaFlows('s', flows, ['m.login.password']))
      .mockResolvedValueOnce('done');
    const prompt = vi
      .fn()
      .mockResolvedValueOnce('wrong-1')
      .mockResolvedValueOnce('wrong-2')
      .mockResolvedValueOnce('right');
    const fallback = vi.fn().mockResolvedValue(true);

    await expect(
      driveUia(makeRequest, { password: { user: USER, prompt }, fallback }),
    ).resolves.toEqual({ result: 'done', password: 'right' });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('prefers a flow it can finish in-app over one that needs the browser', async () => {
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(
        uiaFlows('s', [['m.login.sso'], ['m.login.password']]),
      )
      .mockResolvedValueOnce('done');
    const prompt = vi.fn().mockResolvedValue('pw');
    const fallback = vi.fn();

    await driveUia(makeRequest, { password: { user: USER, prompt }, fallback });
    expect(fallback).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('refuses when no offered flow has a stage it can complete', async () => {
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(uia('s', ['m.login.sso']));

    await expect(
      driveUia(makeRequest, { password: { user: USER, prompt: vi.fn() } }),
    ).rejects.toBeInstanceOf(UiaUnsupportedError);
  });

  it('rethrows a non-UIA failure of the probe', async () => {
    const failure = new MatrixError({ errcode: 'M_UNRECOGNIZED' }, 404);

    await expect(
      driveUia(vi.fn().mockRejectedValue(failure), { fallback: vi.fn() }),
    ).rejects.toBe(failure);
  });
});
