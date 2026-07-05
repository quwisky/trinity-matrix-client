import { MatrixError } from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import { UiaCancelledError, runPasswordUia } from './password-uia';

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
