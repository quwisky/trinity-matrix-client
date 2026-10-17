import { TestBed } from '@angular/core/testing';
import { HTTPError, MatrixError, Method } from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  ContentReportError,
  ContentReportingService,
} from './content-reporting.service';

function fakeClient() {
  return {
    reportRoom: vi.fn(async () => ({})),
    http: { authedRequest: vi.fn(async () => ({})) },
  };
}

function setup(clients: Record<string, ReturnType<typeof fakeClient>>) {
  TestBed.configureTestingModule({
    providers: [
      ContentReportingService,
      {
        provide: MatrixClientService,
        useValue: { clientFor: (id: string) => clients[id] ?? null },
      },
    ],
  });
  return TestBed.inject(ContentReportingService);
}

const matrixError = (errcode: string, status: number, retry?: number) =>
  new MatrixError(
    { errcode, error: 'x', ...(retry ? { retry_after_ms: retry } : {}) },
    status,
  );

describe('ContentReportingService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reports a room as the named account, always sending a reason', async () => {
    const mine = fakeClient();
    const other = fakeClient();
    const svc = setup({ '@me:hs': mine, '@other:hs': other });

    const action = svc.reportRoom({ accountId: '@me:hs', roomId: '!r:hs' }, '');
    expect(mine.reportRoom).not.toHaveBeenCalled();
    await firstValueFrom(action);

    expect(mine.reportRoom).toHaveBeenCalledExactlyOnceWith('!r:hs', '');
    expect(other.reportRoom).not.toHaveBeenCalled();
  });

  it('reports a user on the encoded path with the reason', async () => {
    const mine = fakeClient();
    const svc = setup({ '@me:hs': mine });

    await firstValueFrom(svc.reportUser('@me:hs', '@bad guy:hs', 'spam'));

    expect(mine.http.authedRequest).toHaveBeenCalledExactlyOnceWith(
      Method.Post,
      '/users/%40bad%20guy%3Ahs/report',
      undefined,
      { reason: 'spam' },
    );
  });

  it('types a rate limit with its wait', async () => {
    const mine = fakeClient();
    mine.reportRoom.mockRejectedValue(
      matrixError('M_LIMIT_EXCEEDED', 429, 5000),
    );
    const svc = setup({ '@me:hs': mine });

    const error = await firstValueFrom(
      svc.reportRoom({ accountId: '@me:hs', roomId: '!r:hs' }, ''),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ContentReportError);
    expect((error as ContentReportError).failure).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 5000,
    });
  });

  it('keeps an unknown room apart from a missing endpoint', async () => {
    const mine = fakeClient();
    mine.reportRoom.mockRejectedValue(matrixError('M_NOT_FOUND', 404));
    const svc = setup({ '@me:hs': mine });

    const error = await firstValueFrom(
      svc.reportRoom({ accountId: '@me:hs', roomId: '!r:hs' }, ''),
    ).catch((e: unknown) => e);

    expect((error as ContentReportError).failure).toEqual({
      kind: 'not-found',
    });
    expect(svc.offers('@me:hs', 'room')).toBe(true);
  });

  it.each([
    ['M_UNRECOGNIZED', 400],
    ['M_UNKNOWN', 404],
    ['M_UNKNOWN', 405],
  ])(
    'hides that report kind for the account after %s %s',
    async (errcode, status) => {
      const mine = fakeClient();
      mine.http.authedRequest.mockRejectedValue(matrixError(errcode, status));
      const svc = setup({ '@me:hs': mine, '@other:hs': fakeClient() });

      const error = await firstValueFrom(
        svc.reportUser('@me:hs', '@x:hs', ''),
      ).catch((e: unknown) => e);

      expect((error as ContentReportError).failure).toEqual({
        kind: 'unsupported',
      });
      expect(svc.offers('@me:hs', 'user')).toBe(false);
      expect(svc.offers('@me:hs', 'room')).toBe(true);
      expect(svc.offers('@other:hs', 'user')).toBe(true);
    },
  );

  it('treats a bare 404 without a Matrix body as a missing endpoint', async () => {
    const mine = fakeClient();
    mine.reportRoom.mockRejectedValue(new HTTPError('Not found', 404));
    const svc = setup({ '@me:hs': mine });

    await firstValueFrom(
      svc.reportRoom({ accountId: '@me:hs', roomId: '!r:hs' }, ''),
    ).catch(() => undefined);

    expect(svc.offers('@me:hs', 'room')).toBe(false);
  });

  it('fails typed when the account is not signed in', async () => {
    const svc = setup({});

    const error = await firstValueFrom(
      svc.reportUser('@gone:hs', '@x:hs', ''),
    ).catch((e: unknown) => e);

    expect((error as ContentReportError).failure).toEqual({
      kind: 'not-signed-in',
    });
  });
});
