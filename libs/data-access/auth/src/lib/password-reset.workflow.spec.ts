import { TestBed } from '@angular/core/testing';
import { firstValueFrom, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineFailure } from '@trinity/util/matrix';
import { FakeAuthEngine } from '../contract/fake-auth-engine';
import { AUTH_ENGINE } from './auth-engine.token';
import {
  PasswordResetWorkflow,
  type PendingReset,
} from './password-reset.workflow';

const pending: PendingReset = {
  baseUrl: 'https://hs',
  email: 'a@b.c',
  sid: 'sid-1',
  clientSecret: 'secret-1',
  sendAttempt: 1,
};

function failure(
  kind: EngineFailure['kind'],
  diagnostic: Omit<EngineFailure['diagnostic'], 'kind'> = {},
  serverMessage?: string,
): EngineFailure {
  return {
    kind,
    code: 'request-failed',
    diagnostic: { kind, ...diagnostic },
    ...(serverMessage !== undefined ? { params: { serverMessage } } : {}),
  };
}

describe('PasswordResetWorkflow', () => {
  let engine: FakeAuthEngine;
  let workflow: PasswordResetWorkflow;

  beforeEach(() => {
    engine = new FakeAuthEngine();
    engine.users.set('a', { password: 'old', email: 'a@b.c' });
    TestBed.configureTestingModule({
      providers: [{ provide: AUTH_ENGINE, useValue: engine }],
    });
    workflow = TestBed.inject(PasswordResetWorkflow);
  });

  it('requests a link with a fresh client secret and returns the pending reset', async () => {
    const request = vi.spyOn(engine, 'requestPasswordResetToken');

    const result = await firstValueFrom(
      workflow.sendLink('https://hs', ' a@b.c '),
    );
    const again = await firstValueFrom(
      workflow.sendLink('https://hs', 'a@b.c'),
    );

    expect(result.kind).toBe('sent');
    if (result.kind !== 'sent' || again.kind !== 'sent') return;
    const { clientSecret } = result.pending;
    expect(clientSecret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(again.pending.clientSecret).not.toBe(clientSecret);
    expect(result.pending).toEqual({ ...pending, clientSecret });
    expect(request).toHaveBeenCalledWith('https://hs', {
      email: 'a@b.c',
      clientSecret,
      sendAttempt: 1,
    });
  });

  it('resends with the same secret, the next attempt and the new sid', async () => {
    const request = vi.spyOn(engine, 'requestPasswordResetToken');

    const result = await firstValueFrom(
      workflow.resend({ ...pending, sid: 'old-sid' }),
    );

    expect(request).toHaveBeenCalledWith('https://hs', {
      email: 'a@b.c',
      clientSecret: 'secret-1',
      sendAttempt: 2,
    });
    expect(result).toEqual({
      kind: 'sent',
      pending: { ...pending, sid: 'sid-1', sendAttempt: 2 },
    });
  });

  it.each([true, false])(
    'sets the password with logoutDevices %s once the link is confirmed',
    async (logoutDevices) => {
      const reset = vi.spyOn(engine, 'resetPassword');
      engine.resetLinks.set('sid-1', {
        email: 'a@b.c',
        clientSecret: 'secret-1',
        confirmed: true,
      });

      const result = await firstValueFrom(
        workflow.reset(pending, 'new-pass', logoutDevices),
      );

      expect(reset).toHaveBeenCalledWith('https://hs', {
        sid: 'sid-1',
        clientSecret: 'secret-1',
        newPassword: 'new-pass',
        logoutDevices,
      });
      expect(result).toEqual({ kind: 'reset' });
      expect(engine.users.get('a')?.password).toBe('new-pass');
    },
  );

  it('does nothing until subscribed', () => {
    workflow.sendLink('https://hs', 'a@b.c');
    workflow.resend(pending);
    workflow.reset(pending, 'p', true);

    expect(engine.calls).toEqual([]);
  });

  it('does not retry a failed reset', async () => {
    engine.failure = failure('server', { httpStatus: 500 });

    await firstValueFrom(workflow.reset(pending, 'p', true));

    expect(engine.calls).toEqual(['resetPassword']);
  });

  describe('refusals', () => {
    const send = () => firstValueFrom(workflow.sendLink('https://hs', 'a@b.c'));
    const reset = () => firstValueFrom(workflow.reset(pending, 'p', true));

    it('maps an unknown address', async () => {
      expect(
        await firstValueFrom(workflow.sendLink('https://hs', 'x@y.z')),
      ).toEqual({ kind: 'refused', refusal: 'unknown-address' });
    });

    it.each(['M_INVALID_PARAM', 'M_BAD_JSON'])(
      'maps %s on send to an invalid address',
      async (errcode) => {
        engine.failure = failure('http', { httpStatus: 400, errcode });
        expect(await send()).toEqual({
          kind: 'refused',
          refusal: 'invalid-address',
        });
      },
    );

    it('does not call a reset failure an invalid address', async () => {
      engine.failure = failure('http', {
        httpStatus: 400,
        errcode: 'M_INVALID_PARAM',
      });
      expect(await reset()).toEqual({ kind: 'refused', refusal: 'failed' });
    });

    it('maps M_UNAUTHORIZED to not confirmed', async () => {
      engine.failure = failure('http', {
        httpStatus: 401,
        errcode: 'M_UNAUTHORIZED',
      });
      expect(await reset()).toEqual({
        kind: 'refused',
        refusal: 'not-confirmed',
      });
    });

    it('maps a 401 without an errcode to not confirmed', async () => {
      engine.failure = failure('http', { httpStatus: 401 });
      expect(await reset()).toEqual({
        kind: 'refused',
        refusal: 'not-confirmed',
      });
    });

    it('maps the challenge of an unconfirmed link to not confirmed', async () => {
      expect(await reset()).toEqual({
        kind: 'refused',
        refusal: 'not-confirmed',
      });
    });

    it('maps a weak password with the homeserver reason', async () => {
      engine.failure = failure(
        'http',
        { httpStatus: 400, errcode: 'M_WEAK_PASSWORD' },
        'Too short',
      );
      expect(await reset()).toEqual({
        kind: 'refused',
        refusal: 'weak-password',
        reason: 'Too short',
      });
    });

    it('maps rate limiting with the retry delay', async () => {
      engine.failure = failure('rate-limit', {
        httpStatus: 429,
        errcode: 'M_LIMIT_EXCEEDED',
        retryAfterMs: 5000,
      });
      expect(await send()).toEqual({
        kind: 'refused',
        refusal: 'rate-limited',
        retryAfterMs: 5000,
      });
    });

    it.each([
      ['no connection', failure('network')],
      [
        'a bare fetch TypeError',
        failure('unexpected', { errorName: 'TypeError' }),
      ],
    ])('maps %s to unreachable', async (_, cause) => {
      engine.failure = cause;
      expect(await send()).toEqual({ kind: 'refused', refusal: 'unreachable' });
    });

    it('refuses instead of erroring when the engine faults', async () => {
      vi.spyOn(engine, 'requestPasswordResetToken').mockReturnValue(
        throwError(() => new Error('boom')),
      );
      expect(await send()).toEqual({ kind: 'refused', refusal: 'failed' });
    });

    it('refuses instead of throwing when the engine throws on the call', async () => {
      vi.spyOn(engine, 'resetPassword').mockImplementation(() => {
        throw new Error('boom');
      });
      expect(await reset()).toEqual({ kind: 'refused', refusal: 'failed' });
    });

    it('maps anything else to failed', async () => {
      engine.failure = failure('server', {
        httpStatus: 500,
        errcode: 'M_UNKNOWN',
      });
      expect(await send()).toEqual({ kind: 'refused', refusal: 'failed' });
    });
  });
});
