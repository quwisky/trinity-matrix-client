import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { EngineRequestError, engineFail, engineOk } from './engine-result';
import {
  UiaAttemptsExceededError,
  UiaCancelledError,
  UiaUnsupportedError,
  driveUia,
  engineUia,
  type UiaResponse,
} from './uia-flow';

const USER = '@me:hs';

/** A UIA challenge with the given session + offered stages. */
function uia(
  session: string,
  stages: string[] = ['m.login.password'],
  completed?: string[],
): UiaResponse<never> {
  return {
    kind: 'uia-required',
    challenge: {
      flows: [{ stages }],
      session,
      ...(completed ? { completed } : {}),
    },
  };
}

/** A UIA challenge offering several flows. */
function uiaFlows(
  session: string,
  flows: string[][],
  completed: string[] = [],
): UiaResponse<never> {
  return {
    kind: 'uia-required',
    challenge: {
      flows: flows.map((stages) => ({ stages })),
      session,
      completed,
    },
  };
}

function done<T>(result: T): UiaResponse<T> {
  return { kind: 'done', result };
}

describe('driveUia for the request result', () => {
  it('returns the result without prompting when no auth is required', async () => {
    const send = vi.fn().mockResolvedValue(done('ok'));
    const prompt = vi.fn();

    await expect(
      driveUia(send, { password: { user: USER, prompt } }),
    ).resolves.toMatchObject({ result: 'ok' });
    expect(send).toHaveBeenCalledWith(null);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('submits the password against the returned session', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(uia('s1'))
      .mockResolvedValueOnce(done('done'));
    const prompt = vi.fn().mockResolvedValue('pw');

    await expect(
      driveUia(send, { password: { user: USER, prompt } }),
    ).resolves.toMatchObject({ result: 'done' });
    expect(send.mock.calls[1][0]).toEqual({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: USER },
      password: 'pw',
      session: 's1',
    });
  });

  it('re-prompts after a wrong password, then succeeds', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(uia('s1'))
      .mockResolvedValueOnce(uia('s2'))
      .mockResolvedValueOnce(done('done'));
    const prompt = vi
      .fn()
      .mockResolvedValueOnce('wrong')
      .mockResolvedValueOnce('right');

    await expect(
      driveUia(send, { password: { user: USER, prompt } }),
    ).resolves.toMatchObject({ result: 'done' });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[2][0]).toMatchObject({
      password: 'right',
      session: 's2', // threaded from the failed attempt
    });
  });

  it('throws UiaCancelledError when the prompt is cancelled', async () => {
    const send = vi.fn().mockResolvedValueOnce(uia('s1'));
    const prompt = vi.fn().mockResolvedValue(null);

    await expect(
      driveUia(send, { password: { user: USER, prompt } }),
    ).rejects.toBeInstanceOf(UiaCancelledError);
  });

  it('gives up after too many wrong passwords', async () => {
    const send = vi.fn().mockResolvedValue(uia('s'));
    const prompt = vi.fn().mockResolvedValue('nope');

    await expect(
      driveUia(send, { password: { user: USER, prompt } }),
    ).rejects.toBeInstanceOf(UiaAttemptsExceededError);
    expect(prompt).toHaveBeenCalledTimes(3);
  });

  it('does not spend a user attempt on a replayed password the server rejects', async () => {
    // The caller replays a password an earlier request already had accepted, so the user
    // is not asked twice. When it is rejected anyway (it changed between the requests),
    // the rejection is the *replay's*, and the human must still get all three tries.
    const send = vi.fn().mockResolvedValue(uia('s'));
    const prompt = vi.fn().mockResolvedValue('nope');

    await expect(
      driveUia(send, {
        password: { user: USER, prompt },
        replayedAttempts: 1,
      }),
    ).rejects.toBeInstanceOf(UiaAttemptsExceededError);
    expect(prompt).toHaveBeenCalledTimes(4); // the replay, then three of the user's own
  });

  it('bails clearly when no password stage is offered (e.g. SSO-only)', async () => {
    const send = vi.fn().mockResolvedValueOnce(uia('s1', ['m.login.sso']));
    const prompt = vi.fn();

    await expect(
      driveUia(send, { password: { user: USER, prompt } }),
    ).rejects.toThrow(/additional verification/i);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('rethrows a non-UIA failure without prompting', async () => {
    const failure = new Error('M_LIMIT_EXCEEDED');
    const send = vi.fn().mockRejectedValue(failure);
    const prompt = vi.fn();

    await expect(
      driveUia(send, { password: { user: USER, prompt } }),
    ).rejects.toBe(failure);
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe('driveUia for the accepted password', () => {
  // This is what an irreversible action authenticates with, so the distinction that
  // matters is "the user did not get in" (refuse, and destroy nothing) versus "the
  // request itself failed" (which the caller may choose to carry on past).
  it('reports the password the server accepted', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(uia('s1'))
      .mockResolvedValueOnce(done('done'));
    const prompt = vi.fn().mockResolvedValue('pw');

    await expect(
      driveUia(send, { password: { user: USER, prompt } }),
    ).resolves.toMatchObject({ password: 'pw' });
    expect(send.mock.calls[1][0]).toMatchObject({
      type: 'm.login.password',
      password: 'pw',
      session: 's1',
    });
  });

  it('reports the last accepted password, not a rejected one', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(uia('s1'))
      .mockResolvedValueOnce(uia('s2'))
      .mockResolvedValueOnce(done('done'));
    const prompt = vi
      .fn()
      .mockResolvedValueOnce('wrong')
      .mockResolvedValueOnce('right');

    await expect(
      driveUia(send, { password: { user: USER, prompt } }),
    ).resolves.toMatchObject({ password: 'right' });
  });

  it('reports null when the server asks for no auth at all', async () => {
    const send = vi.fn().mockResolvedValue(done({}));
    const prompt = vi.fn();

    await expect(
      driveUia(send, { password: { user: USER, prompt } }),
    ).resolves.toMatchObject({ password: null });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('refuses when the server offers only a non-password stage (SSO-only)', async () => {
    const send = vi.fn().mockResolvedValueOnce(uia('s', ['m.login.sso']));
    const prompt = vi.fn();

    await expect(
      driveUia(send, { password: { user: USER, prompt } }),
    ).rejects.toBeInstanceOf(UiaUnsupportedError);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('refuses on the OIDC-native cross-signing-reset challenge', async () => {
    // MSC3861 homeservers answer with this shape rather than a login stage.
    const send = vi
      .fn()
      .mockResolvedValueOnce(uia('s', ['org.matrix.cross_signing_reset']));

    await expect(
      driveUia(send, { password: { user: USER, prompt: vi.fn() } }),
    ).rejects.toBeInstanceOf(UiaUnsupportedError);
  });

  it('refuses when the only password stage is already completed', async () => {
    // A multi-stage flow past the password is not something Trinity can finish here.
    const send = vi
      .fn()
      .mockResolvedValueOnce(
        uia('s', ['m.login.password'], ['m.login.password']),
      );

    await expect(
      driveUia(send, { password: { user: USER, prompt: vi.fn() } }),
    ).rejects.toBeInstanceOf(UiaUnsupportedError);
  });

  it('refuses when the user cancels the prompt', async () => {
    const send = vi.fn().mockResolvedValueOnce(uia('s1'));
    const prompt = vi.fn().mockResolvedValue(null);

    await expect(
      driveUia(send, { password: { user: USER, prompt } }),
    ).rejects.toBeInstanceOf(UiaCancelledError);
    expect(send).toHaveBeenCalledTimes(1); // the probe only; nothing authenticated
  });

  it('rethrows the request failure when it is not a UIA verdict', async () => {
    const failure = new Error('M_UNKNOWN');
    const send = vi.fn().mockRejectedValue(failure);

    await expect(
      driveUia(send, { password: { user: USER, prompt: vi.fn() } }),
    ).rejects.toBe(failure);
  });

  it('attempts a password against an empty flow set rather than guessing', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'uia-required',
        challenge: { flows: [], session: 's' },
      })
      .mockResolvedValueOnce(done({}));
    const prompt = vi.fn().mockResolvedValue('pw');

    await expect(
      driveUia(send, { password: { user: USER, prompt } }),
    ).resolves.toMatchObject({ password: 'pw' });
  });
});

describe('driveUia', () => {
  it('sends the probe without auth and returns when the server needs none', async () => {
    const send = vi.fn().mockResolvedValue(done('ok'));

    await expect(
      driveUia(send, { password: { user: USER, prompt: vi.fn() } }),
    ).resolves.toEqual({ result: 'ok', password: null });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(null);
  });

  it('tells the password prompt when the previous password was rejected', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(uia('s1'))
      .mockResolvedValueOnce(uia('s1'))
      .mockResolvedValueOnce(done('done'));
    const prompt = vi
      .fn()
      .mockResolvedValueOnce('wrong')
      .mockResolvedValueOnce('right');

    await expect(
      driveUia(send, { password: { user: USER, prompt } }),
    ).resolves.toEqual({ result: 'done', password: 'right' });
    expect(prompt.mock.calls.map(([context]) => context)).toEqual([
      { rejected: false },
      { rejected: true },
    ]);
  });

  it('stops after three rejected passwords', async () => {
    const send = vi.fn().mockResolvedValue(uia('s'));
    const prompt = vi.fn().mockResolvedValue('nope');

    await expect(
      driveUia(send, { password: { user: USER, prompt } }),
    ).rejects.toBeInstanceOf(UiaAttemptsExceededError);
    expect(prompt).toHaveBeenCalledTimes(3);
  });

  it('completes a non-password stage through the fallback, retrying with the session only', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(uia('s1', ['m.login.sso']))
      .mockResolvedValueOnce(done('done'));
    const fallback = vi.fn().mockResolvedValue(true);

    await expect(driveUia(send, { fallback })).resolves.toEqual({
      result: 'done',
      password: null,
    });
    expect(fallback).toHaveBeenCalledWith({
      stage: 'm.login.sso',
      session: 's1',
      pending: false,
    });
    expect(send.mock.calls[1][0]).toEqual({ session: 's1' });
  });

  it('reports a fallback stage the server has not seen completed yet, as often as asked', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(uia('s1', ['m.login.sso']))
      .mockResolvedValueOnce(uia('s1', ['m.login.sso']))
      .mockResolvedValueOnce(uia('s1', ['m.login.sso']))
      .mockResolvedValueOnce(uia('s1', ['m.login.sso']))
      .mockResolvedValueOnce(done('done'));
    const fallback = vi.fn().mockResolvedValue(true);

    await expect(driveUia(send, { fallback })).resolves.toMatchObject({
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
    const send = vi.fn().mockResolvedValueOnce(uia('s1', ['m.login.sso']));

    await expect(
      driveUia(send, { fallback: vi.fn().mockResolvedValue(false) }),
    ).rejects.toBeInstanceOf(UiaCancelledError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('completes a multi-stage flow one stage at a time', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(
        uiaFlows('s', [['m.login.password', 'm.login.terms']]),
      )
      .mockResolvedValueOnce(
        uiaFlows(
          's',
          [['m.login.password', 'm.login.terms']],
          ['m.login.password'],
        ),
      )
      .mockResolvedValueOnce(done('done'));
    const prompt = vi.fn().mockResolvedValue('pw');
    const fallback = vi.fn().mockResolvedValue(true);

    await expect(
      driveUia(send, { password: { user: USER, prompt }, fallback }),
    ).resolves.toEqual({ result: 'done', password: 'pw' });
    expect(send.mock.calls[1][0]).toMatchObject({
      type: 'm.login.password',
      session: 's',
    });
    expect(fallback).toHaveBeenCalledWith({
      stage: 'm.login.terms',
      session: 's',
      pending: false,
    });
    expect(send.mock.calls[2][0]).toEqual({ session: 's' });
  });

  it('moves on after a correct third password instead of reporting too many', async () => {
    const flows = [['m.login.password', 'm.login.terms']];
    const send = vi
      .fn()
      .mockResolvedValueOnce(uiaFlows('s', flows))
      .mockResolvedValueOnce(uiaFlows('s', flows))
      .mockResolvedValueOnce(uiaFlows('s', flows))
      .mockResolvedValueOnce(uiaFlows('s', flows, ['m.login.password']))
      .mockResolvedValueOnce(done('done'));
    const prompt = vi
      .fn()
      .mockResolvedValueOnce('wrong-1')
      .mockResolvedValueOnce('wrong-2')
      .mockResolvedValueOnce('right');
    const fallback = vi.fn().mockResolvedValue(true);

    await expect(
      driveUia(send, { password: { user: USER, prompt }, fallback }),
    ).resolves.toEqual({ result: 'done', password: 'right' });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('prefers a flow it can finish in-app over one that needs the browser', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(
        uiaFlows('s', [['m.login.sso'], ['m.login.password']]),
      )
      .mockResolvedValueOnce(done('done'));
    const prompt = vi.fn().mockResolvedValue('pw');
    const fallback = vi.fn();

    await driveUia(send, { password: { user: USER, prompt }, fallback });
    expect(fallback).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('refuses when no offered flow has a stage it can complete', async () => {
    const send = vi.fn().mockResolvedValueOnce(uia('s', ['m.login.sso']));

    await expect(
      driveUia(send, { password: { user: USER, prompt: vi.fn() } }),
    ).rejects.toBeInstanceOf(UiaUnsupportedError);
  });

  it('rethrows a non-UIA failure of the probe', async () => {
    const failure = new Error('M_UNRECOGNIZED');

    await expect(
      driveUia(vi.fn().mockRejectedValue(failure), { fallback: vi.fn() }),
    ).rejects.toBe(failure);
  });

  it('fails without a session to answer the challenge on', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      kind: 'uia-required',
      challenge: { flows: [{ stages: ['m.login.password'] }] },
    });

    await expect(
      driveUia(send, { password: { user: USER, prompt: vi.fn() } }),
    ).rejects.toThrow('Authentication failed: missing auth session.');
  });
});

describe('engineUia', () => {
  const challenge = { flows: [{ stages: ['m.login.password'] }], session: 's' };

  it('answers with the result, or the challenge of a uia-required failure', async () => {
    const send = engineUia((auth) =>
      of(
        auth
          ? engineOk('done')
          : engineFail({
              kind: 'http',
              code: 'uia-required',
              diagnostic: { kind: 'http', httpStatus: 401 },
              params: { challenge },
            }),
      ),
    );

    await expect(send(null)).resolves.toEqual({
      kind: 'uia-required',
      challenge,
    });
    await expect(send({ session: 's' })).resolves.toEqual({
      kind: 'done',
      result: 'done',
    });
  });

  it('throws any other failure as an EngineRequestError', async () => {
    const failure = {
      kind: 'permission',
      code: 'forbidden',
      diagnostic: { kind: 'permission', errcode: 'M_FORBIDDEN' },
    } as const;

    const error = await engineUia(() => of(engineFail(failure)))(null).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(EngineRequestError);
    expect((error as EngineRequestError).failure).toBe(failure);
  });
});
