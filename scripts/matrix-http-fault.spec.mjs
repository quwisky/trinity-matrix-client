import { describe, expect, it, vi } from 'vitest';
import {
  installFirstMatrixHttpFailure,
  matrixRequestKind,
} from '../e2e/android/matrix-http-fault.mts';

function connectionFixture() {
  const listeners = new Map();
  const sends = [];
  return {
    sends,
    connection: {
      async send(method, params = {}) {
        sends.push([method, params]);
        if (method === 'Network.getResponseBody') {
          return {
            body: '{"errcode":"M_UNKNOWN","error":"synthetic upstream failure"}',
            base64Encoded: false,
          };
        }
        return {};
      },
      on(method, listener) {
        listeners.set(method, listener);
        return () => listeners.delete(method);
      },
      close() {},
    },
    emit(method, params) {
      listeners.get(method)?.(params);
    },
  };
}

describe('Matrix HTTP fault instrumentation', () => {
  it('classifies only the exact POST invite and join request paths', () => {
    expect(
      matrixRequestKind({
        request: {
          method: 'POST',
          url: 'https://localhost/_matrix/client/v3/rooms/!room%3Alocalhost/invite',
        },
      }),
    ).toBe('invite');
    expect(
      matrixRequestKind({
        request: {
          method: 'POST',
          url: 'https://localhost/_matrix/client/v3/join/!room%3Alocalhost',
        },
      }),
    ).toBe('join');
    for (const candidate of [
      {
        request: {
          method: 'GET',
          url: 'https://localhost/_matrix/client/v3/join/x',
        },
      },
      {
        request: {
          method: 'POST',
          url: 'https://localhost/_matrix/client/v3/rooms/x/invite/extra',
        },
      },
      {
        request: {
          method: 'POST',
          url: 'https://localhost/not-matrix/v3/join/x',
        },
      },
    ]) {
      expect(matrixRequestKind(candidate)).toBeUndefined();
    }
  });

  it('fails the first matching request, continues the second, and counts no others', async () => {
    const fixture = connectionFixture();
    const fault = await installFirstMatrixHttpFailure(fixture.connection, {
      kind: 'invite',
      status: 503,
    });
    fixture.emit('Fetch.requestPaused', {
      requestId: 'unmatched',
      request: { method: 'POST', url: 'https://localhost/health' },
    });
    fixture.emit('Fetch.requestPaused', {
      requestId: 'first',
      networkId: 'network-first',
      request: {
        method: 'POST',
        url: 'https://localhost/_matrix/client/v3/rooms/room/invite',
      },
    });
    fixture.emit('Fetch.requestPaused', {
      requestId: 'second',
      request: {
        method: 'POST',
        url: 'https://localhost/_matrix/client/v3/rooms/room/invite',
      },
    });

    await expect(
      fault.waitForAttempts(2, AbortSignal.timeout(1_000)),
    ).resolves.toBe(2);
    expect(fault.attempts).toBe(2);
    expect(fixture.sends).toContainEqual([
      'Fetch.fulfillRequest',
      expect.objectContaining({
        requestId: 'first',
        responseCode: 503,
        responsePhrase: 'Service Unavailable',
        responseHeaders: expect.arrayContaining([
          { name: 'Access-Control-Allow-Origin', value: '*' },
        ]),
      }),
    ]);
    expect(fixture.sends).toContainEqual([
      'Fetch.continueRequest',
      { requestId: 'second' },
    ]);
    expect(fixture.sends).toContainEqual([
      'Fetch.continueRequest',
      { requestId: 'unmatched' },
    ]);
    fixture.emit('Network.responseReceived', {
      requestId: 'network-first',
      response: { status: 503 },
    });
    fixture.emit('Network.loadingFinished', { requestId: 'network-first' });
    fixture.emit('Runtime.consoleAPICalled', {
      args: [{ value: '[trinity] Matrix request failed' }],
    });
    await vi.waitFor(() =>
      expect(fault.firstOutcome).toEqual({
        responseStatus: 503,
        finished: true,
        bodyBytes: 60,
        bodyMatchesInjected: true,
        handlerReported: true,
      }),
    );
    await fault.close();
    expect(fixture.sends).toContainEqual([
      'Network.getResponseBody',
      { requestId: 'network-first' },
    ]);
    expect(fixture.sends.slice(-3)).toEqual([
      ['Fetch.disable', {}],
      ['Network.disable', {}],
      ['Runtime.disable', {}],
    ]);
  });

  it('records a terminal network failure for the injected request', async () => {
    const fixture = connectionFixture();
    const fault = await installFirstMatrixHttpFailure(fixture.connection, {
      kind: 'join',
      status: 502,
    });
    fixture.emit('Fetch.requestPaused', {
      requestId: 'fetch-first',
      networkId: 'network-first',
      request: {
        method: 'POST',
        url: 'https://localhost/_matrix/client/v3/join/room',
      },
    });
    await fault.waitForAttempts(1, AbortSignal.timeout(1_000));
    fixture.emit('Network.loadingFailed', {
      requestId: 'network-first',
      errorText: 'net::ERR_FAILED',
      blockedReason: 'inspector',
    });
    expect(fault.firstOutcome).toEqual({
      failedReason: 'net::ERR_FAILED',
      blockedReason: 'inspector',
    });
    await fault.close();
  });

  it('unsubscribes before disable and does not replay after close', async () => {
    const fixture = connectionFixture();
    const fault = await installFirstMatrixHttpFailure(fixture.connection, {
      kind: 'join',
      status: 502,
    });
    await fault.close();
    fixture.emit('Fetch.requestPaused', {
      requestId: 'late',
      request: {
        method: 'POST',
        url: 'https://localhost/_matrix/client/v3/join/room',
      },
    });
    await vi.waitFor(() => expect(fault.attempts).toBe(0));
    expect(fixture.sends).not.toContainEqual([
      'Fetch.continueRequest',
      { requestId: 'late' },
    ]);
  });
});
