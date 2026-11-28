import {
  type NativeCryptoBridge,
  NativeCryptoError,
  type NativeCryptoLogger,
  type NativeEvents,
  type NativeRequest,
  type NativeResponse,
} from './types';

export const DEFAULT_MAX_BATCH_LENGTH = 1_000_000;
/** Room kept in every batch for the `pollEvents` requests added to it. */
const POLL_RESERVE = 4096;

type EventListener = (events: NativeEvents) => void;

interface Pending {
  readonly request: NativeRequest;
  readonly line: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

type WireItem =
  | { readonly kind: 'call'; readonly pending: Pending }
  | { readonly kind: 'poll'; readonly key: string; readonly line: string };

const keyOf = ({
  userId,
  deviceId,
}: Pick<NativeRequest, 'userId' | 'deviceId'>) =>
  JSON.stringify([userId, deviceId]);

const isResponse = (value: unknown): value is NativeResponse =>
  typeof value === 'object' &&
  value !== null &&
  ('result' in value || 'error' in value);

/**
 * Coalesces the calls made in one JavaScript task into batches for the bridge, sent one at a
 * time in call order. Each batch also polls the events of every machine it called, and those
 * events reach their listener before any call of the batch settles: WASM runs its callbacks
 * during the call that caused them.
 */
export class CallQueue {
  private queued: Pending[] = [];
  private flushScheduled = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly listeners = new Map<string, EventListener>();

  public constructor(
    private readonly bridge: NativeCryptoBridge,
    private readonly maxBatchLength = DEFAULT_MAX_BATCH_LENGTH,
    private readonly logger?: NativeCryptoLogger,
  ) {}

  public call(request: NativeRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.queued.push({
        request,
        line: JSON.stringify(request),
        resolve,
        reject,
      });
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => this.flush());
      }
    });
  }

  /** Polls this machine's events in every batch that calls it, until `unlisten`. */
  public listen(
    machine: Pick<NativeRequest, 'userId' | 'deviceId'>,
    listener: EventListener,
  ): void {
    this.listeners.set(keyOf(machine), listener);
  }

  public unlisten(machine: Pick<NativeRequest, 'userId' | 'deviceId'>): void {
    this.listeners.delete(keyOf(machine));
  }

  private flush(): void {
    this.flushScheduled = false;
    for (const chunk of this.chunks(this.queued.splice(0))) {
      this.tail = this.tail.then(() => this.send(chunk));
    }
    // A failure inside `send` must not stop the batches queued behind it.
    this.tail = this.tail.catch((error: unknown) =>
      this.logger?.warn('native crypto batch failed', error),
    );
  }

  /** Splits at the size cap; a single call over the cap goes alone. */
  private chunks(calls: readonly Pending[]): Pending[][] {
    const budget = this.maxBatchLength - POLL_RESERVE;
    const chunks: Pending[][] = [];
    let current: Pending[] = [];
    let length = 2;
    for (const pending of calls) {
      if (current.length > 0 && length + pending.line.length + 1 > budget) {
        chunks.push(current);
        current = [];
        length = 2;
      }
      current.push(pending);
      length += pending.line.length + 1;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  private poll(key: string): WireItem {
    const [userId, deviceId] = JSON.parse(key) as [string, string];
    return {
      kind: 'poll',
      key,
      line: JSON.stringify({ method: 'pollEvents', userId, deviceId }),
    };
  }

  /** The calls in order; a machine's poll goes before its `close` (which drops its queue) or last. */
  private wire(chunk: readonly Pending[]): WireItem[] {
    const items: WireItem[] = [];
    const keys = new Set<string>();
    const closed = new Set<string>();
    for (const pending of chunk) {
      const key = keyOf(pending.request);
      if (this.listeners.has(key) && !closed.has(key)) {
        if (pending.request.method === 'close') {
          items.push(this.poll(key));
          closed.add(key);
        } else {
          keys.add(key);
        }
      }
      items.push({ kind: 'call', pending });
    }
    for (const key of keys) if (!closed.has(key)) items.push(this.poll(key));
    return items;
  }

  private async send(chunk: readonly Pending[]): Promise<void> {
    const items = this.wire(chunk);
    const lines = items.map((item) =>
      item.kind === 'call' ? item.pending.line : item.line,
    );
    let responses: unknown;
    try {
      responses = JSON.parse(
        lines.length === 1
          ? await this.bridge.call(lines[0])
          : await this.bridge.callBatch(`[${lines.join(',')}]`),
      );
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      for (const item of items) {
        if (item.kind === 'call') {
          item.pending.reject(
            new Error(
              `native crypto ${item.pending.request.method}: the bridge failed: ${reason}`,
              { cause },
            ),
          );
        }
      }
      return;
    }
    const answers = lines.length === 1 ? [responses] : responses;
    if (
      !Array.isArray(answers) ||
      answers.length !== items.length ||
      !answers.every(isResponse)
    ) {
      const refusal = isResponse(responses) ? responses.error : undefined;
      const error = refusal
        ? new NativeCryptoError('callBatch', refusal.code, refusal.message)
        : new Error(
            'native crypto bridge failed: the batch answer does not match the batch',
          );
      for (const item of items)
        if (item.kind === 'call') item.pending.reject(error);
      return;
    }
    items.forEach((item, index) => {
      if (item.kind !== 'poll') return;
      const answer = answers[index];
      try {
        if (answer.error)
          throw new NativeCryptoError(
            'pollEvents',
            answer.error.code,
            answer.error.message,
          );
        this.listeners.get(item.key)?.(answer.result as NativeEvents);
      } catch (error) {
        this.logger?.warn('native crypto events were not delivered', error);
      }
    });
    items.forEach((item, index) => {
      if (item.kind !== 'call') return;
      const answer = answers[index];
      if (answer.error) {
        const { code, message, details } = answer.error;
        item.pending.reject(
          new NativeCryptoError(
            item.pending.request.method,
            code,
            message,
            details,
          ),
        );
      } else {
        item.pending.resolve(answer.result);
      }
    });
  }
}
