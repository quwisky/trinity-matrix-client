import { describe, expect, it, vi } from 'vitest';
import {
  installFirstMatrixHttpFailure,
  installMatrixRoomStateDelay,
  isMatrixRoomStateRequest,
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

  it('matches only the exact PUT room-state target', () => {
    const target = { roomId: '!space:test', eventType: 'm.room.topic' };
    expect(
      isMatrixRoomStateRequest(
        {
          request: {
            method: 'PUT',
            url: 'https://localhost/_matrix/client/v3/rooms/!space%3Atest/state/m.room.topic',
          },
        },
        target,
      ),
    ).toBe(true);
    expect(
      isMatrixRoomStateRequest(
        {
          request: {
            method: 'PUT',
            url: 'https://localhost/_matrix/client/v3/rooms/!space%3Atest/state/m.room.topic/',
          },
        },
        target,
      ),
    ).toBe(true);
    for (const candidate of [
      {
        request: {
          method: 'POST',
          url: 'https://localhost/_matrix/client/v3/rooms/!space%3Atest/state/m.room.topic',
        },
      },
      {
        request: {
          method: 'PUT',
          url: 'https://localhost/_matrix/client/v3/rooms/!other%3Atest/state/m.room.topic',
        },
      },
      {
        request: {
          method: 'PUT',
          url: 'https://localhost/_matrix/client/v3/rooms/!space%3Atest/state/m.room.name',
        },
      },
      {
        request: {
          method: 'PUT',
          url: 'https://localhost/_matrix/client/v3/rooms/!space%3Atest/state/m.room.topic/nonempty',
        },
      },
    ]) {
      expect(isMatrixRoomStateRequest(candidate, target)).toBe(false);
    }
  });

  it('matches explicit empty state keys with both Matrix empty-route spellings', () => {
    const target = {
      roomId: '!space:test',
      eventType: 'm.room.topic',
      stateKey: '',
    };
    for (const url of [
      'https://localhost/_matrix/client/v3/rooms/!space%3Atest/state/m.room.topic',
      'https://localhost/_matrix/client/v3/rooms/!space%3Atest/state/m.room.topic/',
    ]) {
      expect(
        isMatrixRoomStateRequest({ request: { method: 'PUT', url } }, target),
      ).toBe(true);
    }
  });

  it('matches a wildcard child state key only beneath its exact parent', () => {
    const target = {
      roomId: '!parent:localhost',
      eventType: 'm.space.child',
      stateKey: '*',
    };
    for (const { url, matches } of [
      {
        url: 'https://localhost/_matrix/client/v3/rooms/!parent%3Alocalhost/state/m.space.child/!child%3Alocalhost',
        matches: true,
      },
      {
        url: 'https://localhost/_matrix/client/v3/rooms/!parent%3Alocalhost/state/m.space.child/',
        matches: false,
      },
      {
        url: 'https://localhost/_matrix/client/v3/rooms/!other%3Alocalhost/state/m.space.child/!child%3Alocalhost',
        matches: false,
      },
      {
        url: 'https://localhost/_matrix/client/v3/rooms/!parent%3Alocalhost/state/m.space.parent/!child%3Alocalhost',
        matches: false,
      },
    ]) {
      expect(
        isMatrixRoomStateRequest({ request: { method: 'PUT', url } }, target),
      ).toBe(matches);
    }
  });

  it('counts create-room requests independently of a failed child write', async () => {
    const fixture = connectionFixture();
    const fault = await installFirstMatrixHttpFailure(fixture.connection, {
      kind: 'room-state',
      roomId: '!parent:localhost',
      eventType: 'm.space.child',
      stateKey: '*',
      status: 500,
    });
    fixture.emit('Fetch.requestPaused', {
      requestId: 'create-room',
      request: {
        method: 'POST',
        url: 'https://localhost/_matrix/client/v3/createRoom',
      },
    });
    fixture.emit('Fetch.requestPaused', {
      requestId: 'child',
      request: {
        method: 'PUT',
        url: 'https://localhost/_matrix/client/v3/rooms/!parent%3Alocalhost/state/m.space.child/!child%3Alocalhost',
      },
    });

    await vi.waitFor(() => expect(fault.createRoomAttempts).toBe(1));
    expect(fault.attempts).toBe(1);
    expect(fixture.sends).toContainEqual([
      'Fetch.fulfillRequest',
      expect.objectContaining({ requestId: 'child', responseCode: 500 }),
    ]);
    expect(fixture.sends).toContainEqual([
      'Fetch.continueRequest',
      { requestId: 'create-room' },
    ]);
    await fault.close();
  });

  it('fails only the first exact room-state request and releases its retry', async () => {
    const fixture = connectionFixture();
    const fault = await installFirstMatrixHttpFailure(fixture.connection, {
      kind: 'room-state',
      roomId: '!space:test',
      eventType: 'm.room.topic',
      status: 500,
      responseError: 'retry me',
    });
    fixture.emit('Fetch.requestPaused', {
      requestId: 'name',
      request: {
        method: 'PUT',
        url: 'https://localhost/_matrix/client/v3/rooms/!space%3Atest/state/m.room.name',
      },
    });
    fixture.emit('Fetch.requestPaused', {
      requestId: 'topic-first',
      networkId: 'topic-network',
      request: {
        method: 'PUT',
        url: 'https://localhost/_matrix/client/v3/rooms/!space%3Atest/state/m.room.topic',
      },
    });
    fixture.emit('Fetch.requestPaused', {
      requestId: 'topic-retry',
      request: {
        method: 'PUT',
        url: 'https://localhost/_matrix/client/v3/rooms/!space%3Atest/state/m.room.topic',
      },
    });

    await expect(
      fault.waitForAttempts(2, AbortSignal.timeout(1_000)),
    ).resolves.toBe(2);
    expect(fault.roomStateAttempts('m.room.name')).toBe(1);
    expect(fault.roomStateAttempts('m.room.topic')).toBe(2);
    expect(fixture.sends).toContainEqual([
      'Fetch.fulfillRequest',
      expect.objectContaining({
        requestId: 'topic-first',
        responseCode: 500,
        body: Buffer.from(
          JSON.stringify({ errcode: 'M_UNKNOWN', error: 'retry me' }),
        ).toString('base64'),
      }),
    ]);
    expect(fixture.sends).toContainEqual([
      'Fetch.continueRequest',
      { requestId: 'topic-retry' },
    ]);
    expect(fixture.sends).toContainEqual([
      'Fetch.continueRequest',
      { requestId: 'name' },
    ]);
    await fault.close();
  });

  it('holds the first exact room-state request until release and cleans it on close', async () => {
    const fixture = connectionFixture();
    const delay = await installMatrixRoomStateDelay(fixture.connection, {
      roomId: '!space:test',
      eventType: 'm.room.name',
    });
    fixture.emit('Fetch.requestPaused', {
      requestId: 'topic',
      request: {
        method: 'PUT',
        url: 'https://localhost/_matrix/client/v3/rooms/!space%3Atest/state/m.room.topic',
      },
    });
    fixture.emit('Fetch.requestPaused', {
      requestId: 'name',
      request: {
        method: 'PUT',
        url: 'https://localhost/_matrix/client/v3/rooms/!space%3Atest/state/m.room.name',
      },
    });

    await expect(
      delay.waitForAttempts(1, AbortSignal.timeout(1_000)),
    ).resolves.toBe(1);
    expect(fixture.sends).not.toContainEqual([
      'Fetch.continueRequest',
      { requestId: 'name' },
    ]);
    await delay.release();
    expect(fixture.sends).toContainEqual([
      'Fetch.continueRequest',
      { requestId: 'name' },
    ]);
    expect(fixture.sends).toContainEqual([
      'Fetch.continueRequest',
      { requestId: 'topic' },
    ]);
    await delay.close();

    const cleanupFixture = connectionFixture();
    const cleanupDelay = await installMatrixRoomStateDelay(
      cleanupFixture.connection,
      { roomId: '!space:test', eventType: 'm.room.name' },
    );
    cleanupFixture.emit('Fetch.requestPaused', {
      requestId: 'held-on-close',
      request: {
        method: 'PUT',
        url: 'https://localhost/_matrix/client/v3/rooms/!space%3Atest/state/m.room.name',
      },
    });
    await cleanupDelay.waitForAttempts(1, AbortSignal.timeout(1_000));
    await cleanupDelay.close();
    expect(cleanupFixture.sends).toContainEqual([
      'Fetch.continueRequest',
      { requestId: 'held-on-close' },
    ]);
  });
});
