import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodeHighlightClient,
  REQUEST_DEADLINE_MS,
} from './code-highlight.client';
import type { HighlightResult } from './code-highlight.client';

interface Request {
  readonly seq: number;
  readonly id: string;
  readonly code: string;
}

/** Stands in for the module worker: records requests and replies or fails on demand. */
class FakeWorker {
  readonly posted: Request[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  terminated = false;

  postMessage(request: Request): void {
    this.posted.push(request);
  }
  reply(seq: number, result: HighlightResult): void {
    this.onmessage?.({ data: { seq, result } } as MessageEvent);
  }
  fail(): void {
    this.onerror?.(new Event('error'));
  }
  terminate(): void {
    this.terminated = true;
  }
}

const client = () => {
  const worker = new FakeWorker();
  return {
    worker,
    client: new CodeHighlightClient(() => worker as unknown as Worker),
  };
};

describe('CodeHighlightClient', () => {
  it('resolves each request by seq when replies arrive out of order', async () => {
    const { worker, client: c } = client();
    const first = c.request('python', 'a = 1');
    const second = c.request('json', '{}');
    const [one, two] = worker.posted;

    worker.reply(two.seq, { kind: 'lines', lines: [[['{}', null]]] });
    worker.reply(one.seq, { kind: 'lines', lines: [[['a = 1', null]]] });

    expect(await first).toEqual({ kind: 'lines', lines: [[['a = 1', null]]] });
    expect(await second).toEqual({ kind: 'lines', lines: [[['{}', null]]] });
  });

  it('resolves pending requests as plain and turns unavailable on a worker error', async () => {
    const { worker, client: c } = client();
    const pending = c.request('python', 'a = 1');

    worker.fail();

    expect(await pending).toEqual({ kind: 'plain' });
    expect(c.available()).toBe(false);
    expect(worker.terminated).toBe(true);
    expect(await c.request('python', 'b = 2')).toEqual({ kind: 'plain' });
    expect(worker.posted).toHaveLength(1);
  });

  it('is unavailable when no worker can be created', async () => {
    const c = new CodeHighlightClient(() => null);

    expect(c.available()).toBe(false);
    expect(await c.request('python', 'a = 1')).toEqual({ kind: 'plain' });
  });

  it('applies the caps before posting', async () => {
    const { worker, client: c } = client();

    expect(await c.request('python', 'x'.repeat(4_097))).toEqual({
      kind: 'plain',
    });
    expect(await c.request('python', '   ')).toEqual({ kind: 'plain' });
    expect(worker.posted).toHaveLength(0);
  });

  describe('when the worker hangs', () => {
    afterEach(() => vi.useRealTimers());

    it('restarts it after the deadline and leaves the pending blocks plain', async () => {
      vi.useFakeTimers();
      const workers: FakeWorker[] = [];
      const c = new CodeHighlightClient(() => {
        const created = new FakeWorker();
        workers.push(created);
        return created as unknown as Worker;
      });
      const pending = c.request('python', 'a = 1');

      await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);

      expect(await pending).toEqual({ kind: 'plain' });
      expect(workers[0].terminated).toBe(true);
      expect(workers).toHaveLength(2);
      expect(c.available()).toBe(true);
      const next = c.request('python', 'b = 2');
      expect(workers[1].posted).toHaveLength(1);
      workers[1].reply(workers[1].posted[0].seq, { kind: 'plain' });
      expect(await next).toEqual({ kind: 'plain' });
    });

    it('does not restart a worker that answered in time', async () => {
      vi.useFakeTimers();
      const { worker, client: c } = client();
      const pending = c.request('python', 'a = 1');
      worker.reply(worker.posted[0].seq, { kind: 'plain' });
      await pending;

      await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS * 2);

      expect(worker.terminated).toBe(false);
    });
  });
});
