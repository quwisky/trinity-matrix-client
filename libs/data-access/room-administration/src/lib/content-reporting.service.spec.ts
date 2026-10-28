import { TestBed } from '@angular/core/testing';
import {
  type EngineFailure,
  type MatrixRequestFailureKind,
  engineFail,
} from '@trinity/util/matrix';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ContentReportError,
  ContentReportingService,
} from './content-reporting.service';
import {
  administrationSession,
  roomWithAlice,
} from './room-administration.spec-harness';

async function setup() {
  const session = administrationSession();
  const roomId = await roomWithAlice(session.engine);
  TestBed.configureTestingModule({ providers: session.providers });
  return {
    ...session,
    roomId,
    svc: TestBed.inject(ContentReportingService),
  };
}

/** A server refusal as the js-sdk engine describes it. */
const refusal = (
  kind: MatrixRequestFailureKind,
  diagnostic: { httpStatus?: number; errcode?: string; retryAfterMs?: number },
): EngineFailure => ({
  kind,
  code: 'request-failed',
  diagnostic: { kind, ...diagnostic },
});

const failureOf = (action: Promise<unknown>) =>
  action.then(
    () => null,
    (error: unknown) => (error as ContentReportError).failure,
  );

afterEach(() => TestBed.resetTestingModule());

describe('ContentReportingService', () => {
  it('reports a room as the named account, always sending a reason', async () => {
    const { svc, engine, roomId } = await setup();
    const reportRoom = vi.spyOn(engine, 'reportRoom');

    const action = svc.reportRoom({ accountId: engine.alice, roomId }, '');
    expect(reportRoom).not.toHaveBeenCalled();
    await firstValueFrom(action, { defaultValue: undefined });

    expect(reportRoom).toHaveBeenCalledExactlyOnceWith(
      engine.alice,
      roomId,
      '',
    );
  });

  it('reports a user as the named account with the reason', async () => {
    const { svc, engine } = await setup();
    const reportUser = vi.spyOn(engine, 'reportUser');

    await firstValueFrom(svc.reportUser(engine.alice, '@bad guy:hs', 'spam'), {
      defaultValue: undefined,
    });

    expect(reportUser).toHaveBeenCalledExactlyOnceWith(
      engine.alice,
      '@bad guy:hs',
      'spam',
    );
  });

  it('types a rate limit with its wait', async () => {
    const { svc, engine, roomId } = await setup();
    vi.spyOn(engine, 'reportRoom').mockReturnValue(
      of(
        engineFail(
          refusal('rate-limit', {
            httpStatus: 429,
            errcode: 'M_LIMIT_EXCEEDED',
            retryAfterMs: 5000,
          }),
        ),
      ),
    );

    const error = await firstValueFrom(
      svc.reportRoom({ accountId: engine.alice, roomId }, ''),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ContentReportError);
    expect((error as ContentReportError).failure).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 5000,
    });
  });

  it('keeps an unknown room (M_NOT_FOUND 404) apart from a missing endpoint', async () => {
    const { svc, engine } = await setup();

    // The fake answers an unknown room as Synapse does: 404 M_NOT_FOUND.
    const failure = await failureOf(
      firstValueFrom(
        svc.reportRoom({ accountId: engine.alice, roomId: '!gone:hs' }, ''),
      ),
    );

    expect(failure).toEqual({ kind: 'not-found' });
    expect(svc.offers(engine.alice, 'room')).toBe(true);
  });

  it.each([
    ['M_UNRECOGNIZED', 400],
    ['M_UNKNOWN', 404],
    ['M_UNKNOWN', 405],
  ])(
    'hides that report kind for the account after %s %s',
    async (errcode, httpStatus) => {
      const { svc, engine } = await setup();
      vi.spyOn(engine, 'reportUser').mockImplementation((accountId) =>
        of(
          accountId === engine.alice
            ? engineFail(refusal('http', { httpStatus, errcode }))
            : { ok: true as const, value: null },
        ),
      );

      const failure = await failureOf(
        firstValueFrom(svc.reportUser(engine.alice, '@x:hs', '')),
      );

      expect(failure).toEqual({ kind: 'unsupported' });
      expect(svc.offers(engine.alice, 'user')).toBe(false);
      expect(svc.offers(engine.alice, 'room')).toBe(true);
      expect(svc.offers('@other:hs', 'user')).toBe(true);
    },
  );

  it('treats a bare 404 without a Matrix body as a missing endpoint', async () => {
    const { svc, engine, roomId } = await setup();
    vi.spyOn(engine, 'reportRoom').mockReturnValue(
      of(engineFail(refusal('http', { httpStatus: 404 }))),
    );

    await firstValueFrom(
      svc.reportRoom({ accountId: engine.alice, roomId }, ''),
    ).catch(() => undefined);

    expect(svc.offers(engine.alice, 'room')).toBe(false);
  });

  it('types a reason the server finds too long', async () => {
    const { svc, engine, roomId } = await setup();
    vi.spyOn(engine, 'reportRoom').mockReturnValue(
      of(
        engineFail(
          refusal('http', { httpStatus: 400, errcode: 'M_INVALID_PARAM' }),
        ),
      ),
    );

    const failure = await failureOf(
      firstValueFrom(
        svc.reportRoom({ accountId: engine.alice, roomId }, 'x'.repeat(900)),
      ),
    );

    expect(failure).toEqual({ kind: 'reason-too-long' });
    expect(svc.offers(engine.alice, 'room')).toBe(true);
  });

  it('types any other failure as failed', async () => {
    const { svc, engine } = await setup();
    vi.spyOn(engine, 'reportUser').mockReturnValue(
      of(engineFail(refusal('network', {}))),
    );

    const failure = await failureOf(
      firstValueFrom(svc.reportUser(engine.alice, '@x:hs', '')),
    );

    expect(failure).toEqual({ kind: 'failed' });
    expect(svc.offers(engine.alice, 'user')).toBe(true);
  });

  it('fails typed when the account is not signed in', async () => {
    const { svc } = await setup();

    const failure = await failureOf(
      firstValueFrom(svc.reportUser('@gone:hs', '@x:hs', '')),
    );

    expect(failure).toEqual({ kind: 'not-signed-in' });
  });
});
