import { TestBed } from '@angular/core/testing';
import { MatrixError, createClient } from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PasswordResetWorkflow,
  type PendingReset,
} from './password-reset.workflow';

vi.mock('matrix-js-sdk', async (importActual) => {
  const actual = await importActual<typeof import('matrix-js-sdk')>();
  return { ...actual, createClient: vi.fn() };
});

const pending: PendingReset = {
  baseUrl: 'https://hs',
  email: 'a@b.c',
  sid: 'sid-1',
  clientSecret: 'secret-1',
  sendAttempt: 1,
};

describe('PasswordResetWorkflow', () => {
  const client = {
    generateClientSecret: vi.fn(),
    requestPasswordEmailToken: vi.fn(),
    setPassword: vi.fn(),
  };
  let workflow: PasswordResetWorkflow;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createClient).mockReturnValue(client as never);
    client.generateClientSecret.mockReturnValue('secret-1');
    client.requestPasswordEmailToken.mockResolvedValue({ sid: 'sid-1' });
    client.setPassword.mockResolvedValue({});
    workflow = TestBed.inject(PasswordResetWorkflow);
  });

  it('requests a link on an unauthenticated client and returns the pending reset', async () => {
    const result = await firstValueFrom(
      workflow.sendLink('https://hs', ' a@b.c '),
    );

    expect(createClient).toHaveBeenCalledWith({ baseUrl: 'https://hs' });
    expect(client.requestPasswordEmailToken).toHaveBeenCalledWith(
      'a@b.c',
      'secret-1',
      1,
    );
    expect(result).toEqual({ kind: 'sent', pending });
  });

  it('resends with the same secret, the next attempt and the new sid', async () => {
    client.requestPasswordEmailToken.mockResolvedValue({ sid: 'sid-2' });

    const result = await firstValueFrom(workflow.resend(pending));

    expect(client.generateClientSecret).not.toHaveBeenCalled();
    expect(client.requestPasswordEmailToken).toHaveBeenCalledWith(
      'a@b.c',
      'secret-1',
      2,
    );
    expect(result).toEqual({
      kind: 'sent',
      pending: { ...pending, sid: 'sid-2', sendAttempt: 2 },
    });
  });

  it.each([true, false])(
    'sets the password with logoutDevices %s',
    async (logoutDevices) => {
      const creds = { sid: 'sid-1', client_secret: 'secret-1' };

      const result = await firstValueFrom(
        workflow.reset(pending, 'new-pass', logoutDevices),
      );

      expect(client.setPassword).toHaveBeenCalledWith(
        {
          type: 'm.login.email.identity',
          threepid_creds: creds,
          threepidCreds: creds,
        },
        'new-pass',
        logoutDevices,
      );
      expect(result).toEqual({ kind: 'reset' });
    },
  );

  it('does nothing until subscribed', () => {
    workflow.sendLink('https://hs', 'a@b.c');
    workflow.resend(pending);
    workflow.reset(pending, 'p', true);

    expect(createClient).not.toHaveBeenCalled();
    expect(client.requestPasswordEmailToken).not.toHaveBeenCalled();
    expect(client.setPassword).not.toHaveBeenCalled();
  });

  it('does not retry a failed reset', async () => {
    client.setPassword.mockRejectedValue(new MatrixError({}, 500));

    await firstValueFrom(workflow.reset(pending, 'p', true));

    expect(client.setPassword).toHaveBeenCalledTimes(1);
  });

  describe('refusals', () => {
    const matrix = (
      errcode: string | undefined,
      httpStatus: number,
      extra: Record<string, unknown> = {},
    ): MatrixError =>
      new MatrixError(
        { ...(errcode ? { errcode } : {}), ...extra },
        httpStatus,
      );

    it('maps an unknown address', async () => {
      client.requestPasswordEmailToken.mockRejectedValue(
        matrix('M_THREEPID_NOT_FOUND', 400),
      );
      expect(
        await firstValueFrom(workflow.sendLink('https://hs', 'a@b.c')),
      ).toEqual({ kind: 'refused', refusal: 'unknown-address' });
    });

    it.each(['M_INVALID_PARAM', 'M_BAD_JSON'])(
      'maps %s on send to an invalid address',
      async (errcode) => {
        client.requestPasswordEmailToken.mockRejectedValue(
          matrix(errcode, 400),
        );
        expect(
          await firstValueFrom(workflow.sendLink('https://hs', 'a@b.c')),
        ).toEqual({ kind: 'refused', refusal: 'invalid-address' });
      },
    );

    it('does not call a reset failure an invalid address', async () => {
      client.setPassword.mockRejectedValue(matrix('M_INVALID_PARAM', 400));
      expect(await firstValueFrom(workflow.reset(pending, 'p', true))).toEqual({
        kind: 'refused',
        refusal: 'failed',
      });
    });

    it('maps M_UNAUTHORIZED to not confirmed', async () => {
      client.setPassword.mockRejectedValue(matrix('M_UNAUTHORIZED', 401));
      expect(await firstValueFrom(workflow.reset(pending, 'p', true))).toEqual({
        kind: 'refused',
        refusal: 'not-confirmed',
      });
    });

    it('maps a 401 challenge without an errcode to not confirmed', async () => {
      client.setPassword.mockRejectedValue(
        matrix(undefined, 401, {
          flows: [{ stages: ['m.login.email.identity'] }],
        }),
      );
      expect(await firstValueFrom(workflow.reset(pending, 'p', true))).toEqual({
        kind: 'refused',
        refusal: 'not-confirmed',
      });
    });

    it('maps a weak password with the homeserver reason', async () => {
      client.setPassword.mockRejectedValue(
        matrix('M_WEAK_PASSWORD', 400, { error: 'Too short' }),
      );
      expect(await firstValueFrom(workflow.reset(pending, 'p', true))).toEqual({
        kind: 'refused',
        refusal: 'weak-password',
        reason: 'Too short',
      });
    });

    it('maps rate limiting with the retry delay', async () => {
      client.requestPasswordEmailToken.mockRejectedValue(
        matrix('M_LIMIT_EXCEEDED', 429, { retry_after_ms: 5000 }),
      );
      expect(
        await firstValueFrom(workflow.sendLink('https://hs', 'a@b.c')),
      ).toEqual({
        kind: 'refused',
        refusal: 'rate-limited',
        retryAfterMs: 5000,
      });
    });

    it('maps a network failure to unreachable', async () => {
      client.requestPasswordEmailToken.mockRejectedValue(
        new TypeError('Failed to fetch'),
      );
      expect(
        await firstValueFrom(workflow.sendLink('https://hs', 'a@b.c')),
      ).toEqual({ kind: 'refused', refusal: 'unreachable' });
    });

    it('refuses instead of erroring when the client cannot be created', async () => {
      vi.mocked(createClient).mockImplementation(() => {
        throw new Error('boom');
      });
      expect(
        await firstValueFrom(workflow.sendLink('https://hs', 'a@b.c')),
      ).toEqual({ kind: 'refused', refusal: 'failed' });
    });

    it('maps anything else to failed', async () => {
      client.requestPasswordEmailToken.mockRejectedValue(
        matrix('M_UNKNOWN', 500),
      );
      expect(
        await firstValueFrom(workflow.sendLink('https://hs', 'a@b.c')),
      ).toEqual({ kind: 'refused', refusal: 'failed' });
    });
  });
});
