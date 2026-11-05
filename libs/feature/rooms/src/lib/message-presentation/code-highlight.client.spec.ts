import { describe, expect, it } from 'vitest';
import { CodeHighlightClient } from './code-highlight.client';
import type { Run } from './code-tokens';

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
  reply(seq: number, lines: Run[][] | null): void {
    this.onmessage?.({ data: { seq, lines } } as MessageEvent);
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

    worker.reply(two.seq, [[['{}', null]]]);
    worker.reply(one.seq, [[['a = 1', null]]]);

    expect(await first).toEqual([[['a = 1', null]]]);
    expect(await second).toEqual([[['{}', null]]]);
  });

  it('resolves pending requests with null and turns unavailable on a worker error', async () => {
    const { worker, client: c } = client();
    const pending = c.request('python', 'a = 1');

    worker.fail();

    expect(await pending).toBeNull();
    expect(c.available()).toBe(false);
    expect(worker.terminated).toBe(true);
    expect(await c.request('python', 'b = 2')).toBeNull();
    expect(worker.posted).toHaveLength(1);
  });

  it('is unavailable when no worker can be created', async () => {
    const c = new CodeHighlightClient(() => null);

    expect(c.available()).toBe(false);
    expect(await c.request('python', 'a = 1')).toBeNull();
  });

  it('applies the caps before posting', async () => {
    const { worker, client: c } = client();

    expect(await c.request('python', 'x'.repeat(4_097))).toBeNull();
    expect(await c.request('python', '   ')).toBeNull();
    expect(worker.posted).toHaveLength(0);
  });
});
