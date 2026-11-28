import { setFlagsFromString } from 'node:v8';
import { inspect } from 'node:util';
import { runInNewContext } from 'node:vm';

import { CallQueue, QUIET_METHODS } from './call-queue';
import {
  NativeBridgeError,
  NativeCryptoError,
  type NativeEvents,
  type NativeRequest,
  type NativeResponse,
} from './types';

/** A bridge that answers each request with `answer` and records the batches it was sent. */
function fakeBridge(answer: (request: NativeRequest) => NativeResponse) {
  const batches: NativeRequest[][] = [];
  const run = async (text: string): Promise<string> => {
    const parsed = JSON.parse(text) as NativeRequest | NativeRequest[];
    const requests = Array.isArray(parsed) ? parsed : [parsed];
    batches.push(requests);
    const answers = requests.map(answer);
    return JSON.stringify(Array.isArray(parsed) ? answers : answers[0]);
  };
  return { batches, bridge: { call: run, callBatch: run } };
}

const alice = { userId: '@alice:example.org', deviceId: 'ALICE' };
const echo = (request: NativeRequest): NativeResponse =>
  request.method === 'pollEvents'
    ? { result: { events: [], dropped: 0 } }
    : { result: request.params?.['value'] ?? null };
const call = (queue: CallQueue, method: string, value?: unknown) =>
  queue.call({ method, ...alice, params: { value } });

describe('CallQueue', () => {
  it('traces methods and event states only, never parameters or answers', async () => {
    const lines: string[] = [];
    const { bridge } = fakeBridge((request) =>
      request.method === 'pollEvents'
        ? {
            result: {
              events: [
                {
                  type: 'verificationChanged',
                  verification: {
                    kind: 'sas',
                    flowId: 'flow',
                    isDone: true,
                    decimals: [1, 2, 3],
                  },
                },
              ],
              dropped: 0,
            },
          }
        : { result: 'secret-answer' },
    );
    const queue = new CallQueue(bridge, { trace: (line) => lines.push(line) });
    queue.listen(alice, () => undefined);
    await call(queue, 'importSecretsBundle', 'secret-parameter');
    expect(lines).toEqual([
      `batch 1 ${JSON.stringify([alice.userId, alice.deviceId])} importSecretsBundle +poll`,
      `events 1 ${JSON.stringify([alice.userId, alice.deviceId])} verificationChanged(flow kind=sas,isDone=true) dropped=0`,
    ]);
  });

  it('sends the calls of one task as one batch and answers them in call order', async () => {
    const { batches, bridge } = fakeBridge(echo);
    const queue = new CallQueue(bridge);
    const answers = await Promise.all(
      [1, 2, 3].map((value) => call(queue, 'step', value)),
    );
    expect(answers).toEqual([1, 2, 3]);
    expect(
      batches.map((batch) => batch.map(({ params }) => params?.['value'])),
    ).toEqual([[1, 2, 3]]);
  });

  it('splits a batch at the size cap and keeps the order across batches', async () => {
    const { batches, bridge } = fakeBridge(echo);
    const cap = 4096 + 300;
    const queue = new CallQueue(bridge, { maxBatchLength: cap });
    const values = Array.from({ length: 7 }, (_, index) =>
      `${index}`.padEnd(100, '.'),
    );
    expect(
      await Promise.all(values.map((value) => call(queue, 'step', value))),
    ).toEqual(values);
    expect(batches.length).toBeGreaterThan(2);
    for (const batch of batches)
      expect(JSON.stringify(batch).length).toBeLessThanOrEqual(cap);
    expect(batches.flat().map(({ params }) => params?.['value'])).toEqual(
      values,
    );
  });

  it('fails only the item the crate refused', async () => {
    const { bridge } = fakeBridge((request) =>
      request.params?.['value'] === 'bad'
        ? { error: { code: 'InvalidRequest', message: 'no' } }
        : echo(request),
    );
    const queue = new CallQueue(bridge);
    const [first, bad, last] = await Promise.allSettled([
      call(queue, 'step', 'a'),
      call(queue, 'step', 'bad'),
      call(queue, 'step', 'c'),
    ]);
    expect(first).toEqual({ status: 'fulfilled', value: 'a' });
    expect(last).toEqual({ status: 'fulfilled', value: 'c' });
    expect(bad.status === 'rejected' && bad.reason).toBeInstanceOf(
      NativeCryptoError,
    );
    expect(bad.status === 'rejected' && bad.reason.code).toBe('InvalidRequest');
  });

  it('polls a listening machine in its batch and delivers the events before the calls settle', async () => {
    const events: NativeEvents = {
      events: [{ type: 'devicesUpdated', userIds: [] }],
      dropped: 0,
    };
    const { batches, bridge } = fakeBridge((request) =>
      request.method === 'pollEvents' ? { result: events } : echo(request),
    );
    const queue = new CallQueue(bridge);
    const order: string[] = [];
    queue.listen(alice, (delivered) =>
      order.push(`events ${delivered.events.length}`),
    );
    await call(queue, 'step', 1).then(() => order.push('resolved'));
    expect(order).toEqual(['events 1', 'resolved']);
    expect(batches[0].map(({ method }) => method)).toEqual([
      'step',
      'pollEvents',
    ]);
  });

  it('polls before a close, which drops the queue', async () => {
    const { batches, bridge } = fakeBridge(echo);
    const queue = new CallQueue(bridge);
    queue.listen(alice, () => undefined);
    await Promise.all([call(queue, 'step'), call(queue, 'close')]);
    expect(batches[0].map(({ method }) => method)).toEqual([
      'step',
      'pollEvents',
      'close',
    ]);
  });

  it('sends a call made by an event callback in the next batch', async () => {
    let polls = 0;
    const { batches, bridge } = fakeBridge((request) =>
      request.method === 'pollEvents'
        ? {
            result: {
              events: polls++ === 0 ? [{ type: 'roomKeysReceived' }] : [],
              dropped: 0,
            },
          }
        : echo(request),
    );
    const queue = new CallQueue(bridge);
    let nested: Promise<unknown> | undefined;
    queue.listen(alice, ({ events }) => {
      if (events.length > 0) nested = call(queue, 'retry', 'again');
    });
    expect(await call(queue, 'step', 'first')).toBe('first');
    expect(await nested).toBe('again');
    expect(batches.map((batch) => batch[0].method)).toEqual(['step', 'retry']);
  });

  it('rejects every call of a batch the bridge failed, and goes on with the next one', async () => {
    let fail = true;
    const { bridge } = fakeBridge(echo);
    const queue = new CallQueue({
      call: bridge.call,
      callBatch: (text) =>
        fail
          ? Promise.reject(new Error('process died'))
          : bridge.callBatch(text),
    });
    const failed = await Promise.allSettled([
      call(queue, 'one'),
      call(queue, 'two'),
    ]);
    expect(
      failed.map(
        (result) => result.status === 'rejected' && result.reason.message,
      ),
    ).toEqual([
      'native crypto one: the bridge failed',
      'native crypto two: the bridge failed',
    ]);
    fail = false;
    expect(
      await Promise.all([call(queue, 'three', 3), call(queue, 'four', 4)]),
    ).toEqual([3, 4]);
  });

  it('settles the calls of a batch whose event listener throws', async () => {
    const logger = { warn: vi.fn() };
    const { bridge } = fakeBridge(echo);
    const queue = new CallQueue(bridge, { logger });
    queue.listen(alice, () => {
      throw new Error('listener broke');
    });
    expect(await call(queue, 'step', 1)).toBe(1);
    expect(await call(queue, 'step', 2)).toBe(2);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('gives a batch the time of the slowest call class it holds, and warns once a minute passed', async () => {
    const never = () => new Promise<string>(() => undefined);
    const logger = { warn: vi.fn() };
    const queue = new CallQueue(
      { call: never, callBatch: never },
      {
        timeoutMs: 20,
        heavyTimeoutMs: 80,
        slowTimeoutMs: 160,
        warnAfterMs: 40,
        logger,
      },
    );
    const time = async (method: string) => {
      const started = Date.now();
      const error = await call(queue, method).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(NativeBridgeError);
      expect((error as Error).message).toBe(
        `native crypto ${method}: the bridge timed out`,
      );
      return Date.now() - started;
    };
    expect(await time('trackedUsers')).toBeLessThan(80);
    expect(logger.warn).not.toHaveBeenCalled();
    for (const method of [
      'receiveSyncChanges',
      'shareRoomKey',
      'markRequestAsSent',
      'getMissingSessions',
    ]) {
      const took = await time(method);
      expect(took).toBeGreaterThanOrEqual(70);
      expect(took).toBeLessThan(160);
    }
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/receiveSyncChanges.*still waiting/),
    );
    expect(await time('importExportedRoomKeys')).toBeGreaterThanOrEqual(150);
  });

  it('reports a failed or malformed poll to the machine', async () => {
    let poll: NativeResponse = {
      error: { code: 'UnknownMachine', message: 'gone' },
    };
    const { bridge } = fakeBridge((request) =>
      request.method === 'pollEvents' ? poll : echo(request),
    );
    const queue = new CallQueue(bridge);
    const failures: [string, boolean][] = [];
    queue.listen(
      alice,
      () => undefined,
      (reason, malformed) => failures.push([reason, malformed]),
    );
    await call(queue, 'step');
    poll = { result: { events: 'nope', dropped: 0 } };
    await call(queue, 'step');
    expect(failures).toEqual([
      ['native crypto pollEvents failed (UnknownMachine)', false],
      ['native crypto pollEvents answered an unexpected shape', true],
    ]);
  });

  it('keeps the bridge failure reason out of every call of a batch that carries init', async () => {
    const queue = new CallQueue({
      call: () => Promise.reject(new Error('request {"storeKey":"secret"}')),
      callBatch: () =>
        Promise.reject(new Error('request {"storeKey":"secret"}')),
    });
    const answers = await Promise.allSettled([
      call(queue, 'init'),
      call(queue, 'roomKeyRequestsEnabled'),
    ]);
    for (const answer of answers) {
      expect(answer.status === 'rejected' && answer.reason.message).not.toMatch(
        /secret/,
      );
    }
  });

  it('keeps no cause on the errors of a batch that carries init', async () => {
    const queue = new CallQueue({
      call: () => Promise.reject(new Error('request {"storeKey":"secret"}')),
      callBatch: () =>
        Promise.reject(new Error('request {"storeKey":"secret"}')),
    });
    const answers = await Promise.allSettled([
      call(queue, 'init'),
      call(queue, 'trackedUsers'),
    ]);
    for (const answer of answers) {
      expect(
        answer.status === 'rejected' && answer.reason.cause,
      ).toBeUndefined();
    }
    const debugged = await call(
      new CallQueue(
        {
          call: () => Promise.reject(new Error('died')),
          callBatch: () => Promise.reject(new Error('died')),
        },
        { debugBridgeErrors: true },
      ),
      'trackedUsers',
    ).catch((error: unknown) => error);
    expect((debugged as Error).cause).toBeInstanceOf(Error);
  });

  it('lets go of init parameters once the batch is with the bridge', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const never = () => new Promise<string>(() => undefined);
    const queue = new CallQueue({ call: never, callBatch: never });
    let params: Record<string, string> | undefined = { storeKey: 'secret' };
    const ref = new WeakRef(params);
    void queue.call({ method: 'init', ...alice, params });
    params = undefined;
    let gone = false;
    for (let attempt = 0; attempt < 10 && !gone; attempt++) {
      await new Promise((done) => setTimeout(done, 0));
      gc();
      gone = !ref.deref();
    }
    expect(gone).toBe(true);
  });

  describe('keeps bridge and parser text out of every error', () => {
    const MARKER = 'MARKER-7f3a';
    const shown = (error: unknown) =>
      [
        (error as Error).message,
        (error as Error).stack,
        String((error as Error).cause ?? ''),
        (error as Error).cause instanceof Error
          ? ((error as Error).cause as Error).stack
          : '',
        JSON.stringify(error),
        inspect(error, { depth: 10 }),
      ].join('\n');
    const PATHS: Record<
      string,
      () => {
        call(text: string): Promise<string>;
        callBatch(text: string): Promise<string>;
      }
    > = {
      'a transport failure': () => {
        const fail = (text: string) =>
          Promise.reject(
            new Error(`broken pipe while writing ${text} ${MARKER}`),
          );
        return { call: fail, callBatch: fail };
      },
      'a timeout': () => {
        const never = () => new Promise<string>(() => undefined);
        return { call: never, callBatch: never };
      },
      'a refusal of the whole batch': () => {
        const refuse = async (text: string) =>
          JSON.stringify({
            error: {
              code: 'InvalidRequest',
              message: `invalid type: string "${text}" ${MARKER}`,
            },
          });
        return { call: refuse, callBatch: refuse };
      },
      'an answer that is not JSON': () => {
        const broken = async () => `${MARKER} not json`;
        return { call: broken, callBatch: broken };
      },
      'an answer of the wrong shape': () => {
        const wrong = async () => JSON.stringify([{ result: MARKER }]);
        return { call: wrong, callBatch: wrong };
      },
    };
    const send = async (
      path: string,
      method: string,
      debugBridgeErrors = false,
    ): Promise<unknown[]> => {
      const queue = new CallQueue(PATHS[path]!(), {
        timeoutMs: 20,
        heavyTimeoutMs: 20,
        slowTimeoutMs: 20,
        debugBridgeErrors,
      });
      // Two calls: a batch, so a refusal of it is the whole batch's.
      const answers = await Promise.allSettled([
        call(queue, method, MARKER),
        call(queue, 'trackedUsers', MARKER),
      ]);
      return answers.map((answer) => {
        expect(answer.status).toBe('rejected');
        return (answer as PromiseRejectedResult).reason;
      });
    };

    it.each(
      Object.keys(PATHS).flatMap((path) => [
        [path, 'saveBackupDecryptionKey'],
        [path, 'trackedUsers'],
        // Slice 4's: a quiet call (a secrets bundle in) and a secret answer (one out).
        [path, 'importSecretsBundle'],
        [path, 'exportSecretsBundle'],
      ]),
    )(
      'after %s, a batch with %s shows no request or answer text',
      async (path, method) => {
        for (const error of await send(path, method)) {
          expect(shown(error)).not.toContain(MARKER);
          expect(error).toHaveProperty(
            error instanceof NativeBridgeError ? 'kind' : 'code',
          );
        }
      },
    );

    it.each(
      Object.keys(PATHS).filter(
        (path) => !['a timeout', 'an answer of the wrong shape'].includes(path),
      ),
    )(
      'with debugBridgeErrors, %s shows its text for a call without secrets only',
      async (path) => {
        const [plain] = await send(path, 'trackedUsers', true);
        expect(shown(plain)).toContain(MARKER);
        for (const error of await send(path, 'saveBackupDecryptionKey', true)) {
          expect(shown(error)).not.toContain(MARKER);
        }
      },
    );

    it('lets the crate message of a per-call error through, except for code-only calls', async () => {
      const refuse = async (text: string) =>
        JSON.stringify(
          (JSON.parse(text) as NativeRequest[]).map(() => ({
            error: {
              code: 'StoreError',
              message: `crate says ${MARKER}`,
              details: { m: MARKER },
            },
          })),
        );
      const queue = new CallQueue({ call: refuse, callBatch: refuse });
      const [plain, ...codeOnlyErrors] = (
        await Promise.allSettled([
          call(queue, 'trackedUsers'),
          call(queue, 'importCrossSigningKeys'),
          call(queue, 'exportCrossSigningKeys'),
          call(queue, 'rehydrateDevice'),
          call(queue, 'qrCodeBytes'),
        ])
      ).map(
        (answer) =>
          (answer as PromiseRejectedResult).reason as NativeCryptoError,
      );
      expect(plain!.message).toContain(MARKER);
      for (const error of codeOnlyErrors) {
        expect(error.code).toBe('StoreError');
        expect(shown(error)).not.toContain(MARKER);
      }
    });

    it('repeats no bridge code that is not a plain word', async () => {
      const refuse = async () =>
        JSON.stringify({ error: { code: `Bad ${MARKER}`, message: 'x' } });
      const queue = new CallQueue({ call: refuse, callBatch: refuse });
      const [error] = await Promise.allSettled([
        call(queue, 'a'),
        call(queue, 'b'),
      ]);
      expect((error as PromiseRejectedResult).reason).toMatchObject({
        code: 'BridgeRefused',
      });
    });
  });

  it('treats every call that carries key material or plaintext as quiet', () => {
    expect([...QUIET_METHODS].sort()).toEqual(
      [
        'createDehydratedDevice',
        'encryptRoomEvent',
        'encryptStateEvent',
        'encryptToDeviceEvent',
        'importBackedUpRoomKeys',
        'importCrossSigningKeys',
        'importExportedRoomKeys',
        'importSecretsBundle',
        'init',
        'receiveRoomKeyBundle',
        'rehydrateDevice',
        'saveBackupDecryptionKey',
        'saveDehydratedDeviceKey',
        'scanQrCode',
        'shareRoomKeyBundleData',
      ].sort(),
    );
  });

  it.each([...QUIET_METHODS])(
    'keeps the bridge failure out of a batch that carries %s: fixed message, no cause',
    async (method) => {
      const failing = () =>
        Promise.reject(new Error('request {"params":{"value":"secret"}}'));
      const queue = new CallQueue({ call: failing, callBatch: failing });
      const answers = await Promise.allSettled([
        call(queue, method, 'secret'),
        call(queue, 'trackedUsers'),
      ]);
      for (const answer of answers) {
        expect(answer.status).toBe('rejected');
        const reason = (answer as PromiseRejectedResult).reason as Error;
        expect(reason).toBeInstanceOf(NativeBridgeError);
        expect(reason.message).not.toMatch(/secret/);
        expect(reason.cause).toBeUndefined();
      }
    },
  );

  it.each([...QUIET_METHODS].filter((method) => method !== 'init'))(
    'lets go of the parameters of %s once the batch is with the bridge',
    async (method) => {
      setFlagsFromString('--expose-gc');
      const gc = runInNewContext('gc') as () => void;
      const never = () => new Promise<string>(() => undefined);
      const queue = new CallQueue({ call: never, callBatch: never });
      let params: Record<string, string> | undefined = { value: 'secret' };
      const ref = new WeakRef(params);
      void queue.call({ method, ...alice, params });
      params = undefined;
      let gone = false;
      for (let attempt = 0; attempt < 10 && !gone; attempt++) {
        await new Promise((done) => setTimeout(done, 0));
        gc();
        gone = !ref.deref();
      }
      expect(gone).toBe(true);
    },
  );

  it('sends each machine its own batch, so a stuck one loses only its own calls', async () => {
    const { batches, bridge } = fakeBridge(echo);
    const queue = new CallQueue(bridge);
    const bob = { userId: '@bob:example.org', deviceId: 'BOB' };
    const answers = await Promise.all([
      call(queue, 'a1', 1),
      queue.call({ method: 'b1', ...bob, params: { value: 2 } }),
      call(queue, 'a2', 3),
    ]);
    expect(answers).toEqual([1, 2, 3]);
    expect(batches.map((batch) => batch.map(({ method }) => method))).toEqual([
      ['a1', 'a2'],
      ['b1'],
    ]);
  });
});
