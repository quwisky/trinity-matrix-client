import { CallQueue } from './call-queue';
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
      'native crypto one: the bridge failed: process died',
      'native crypto two: the bridge failed: process died',
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

  it('rejects a batch the bridge does not answer in time, with a longer limit for slow calls', async () => {
    const never = () => new Promise<string>(() => undefined);
    const queue = new CallQueue(
      { call: never, callBatch: never },
      { timeoutMs: 20, slowTimeoutMs: 200 },
    );
    const started = Date.now();
    const fast = await call(queue, 'trackedUsers').catch(
      (error: unknown) => error,
    );
    expect(fast).toBeInstanceOf(NativeBridgeError);
    expect((fast as Error).message).toBe(
      'native crypto trackedUsers: the bridge timed out',
    );
    const slow = await call(queue, 'importExportedRoomKeys').catch(
      (error: unknown) => error,
    );
    expect(slow).toBeInstanceOf(NativeBridgeError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
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
});
