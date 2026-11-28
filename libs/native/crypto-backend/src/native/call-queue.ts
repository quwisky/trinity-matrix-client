import {
  describeError,
  NativeBridgeError,
  type NativeCryptoBridge,
  NativeCryptoError,
  type NativeCryptoLogger,
  type NativeEvents,
  type NativeRequest,
  type NativeResponse,
} from './types';

export const DEFAULT_MAX_BATCH_LENGTH = 1_000_000;
/**
 * How long a batch may take before the bridge counts as stuck and its machines are lost; a batch
 * gets the longest limit of the calls it holds. A false loss stops a healthy client, so the limits
 * are generous: a local bridge answers in milliseconds.
 */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Calls whose work grows with a sync or a room's members. */
export const DEFAULT_HEAVY_TIMEOUT_MS = 300_000;
const HEAVY_METHODS = new Set([
  'receiveSyncChanges',
  'receiveSyncChangesMsc4186',
  'shareRoomKey',
  'markRequestAsSent',
  'getMissingSessions',
]);
/** Calls whose work grows with all of the user's data. */
export const DEFAULT_SLOW_TIMEOUT_MS = 600_000;
const SLOW_METHODS = new Set([
  'init',
  'exportRoomKeys',
  'importExportedRoomKeys',
  'importBackedUpRoomKeys',
]);
/**
 * Error text. Nothing the bridge layer says, and nothing from parsing its output, enters a
 * shim error: transport failures, timeouts, a refusal of the whole batch and an answer that does
 * not parse or has the wrong shape get fixed messages and a machine-readable `kind` or `code`
 * (a bridge's or parser's text may quote the request or the answer). The one text let through is
 * the crate's own `message` of a well-formed per-call error, which the crate keeps free of key
 * material by design, and not even that for the calls below (code only, no details).
 * `debugBridgeErrors` restores the bridge's text for calls not listed here; never in a release.
 *
 * Calls whose parameters carry key material or plaintext: the store key, private cross-signing
 * keys, the backup key, room keys, a secrets bundle, a dehydration key, the scanned QR secret, or
 * the cleartext of an event to encrypt. The queue also drops their parameters once the batch text
 * is with the bridge; a replayable one is sent again from the parameters its caller holds until
 * it settles (machine.ts), never from the queue's copy. Sync inputs are not here: they carry
 * to-device ciphertext and public key counts. A slice that adds a call carrying a secret adds it
 * here.
 */
export const QUIET_METHODS: ReadonlySet<string> = new Set([
  'init',
  'saveBackupDecryptionKey',
  'importCrossSigningKeys',
  'importExportedRoomKeys',
  'importBackedUpRoomKeys',
  'encryptRoomEvent',
  'encryptStateEvent',
  'encryptToDeviceEvent',
  'importSecretsBundle',
  'createDehydratedDevice',
  'rehydrateDevice',
  'saveDehydratedDeviceKey',
  'scanQrCode',
  // The bundle's file key (`mediaEncryptionInfo`), and the downloaded bundle.
  'shareRoomKeyBundleData',
  'receiveRoomKeyBundle',
]);
/**
 * Calls whose ANSWERS carry secrets (private keys, room keys, the backup key, inbox secrets, a
 * secrets bundle, a dehydration key, QR bytes): their per-call errors are code only too. Not
 * `decryptRoomEvent`: a failed decryption returns no plaintext, and its structured details
 * (the decryption error code matrix-js-sdk shows) are needed.
 */
export const SECRET_ANSWER_METHODS: ReadonlySet<string> = new Set([
  'exportCrossSigningKeys',
  'exportRoomKeys',
  'getBackupKeys',
  'getSecretsFromInbox',
  'exportSecretsBundle',
  'getDehydratedDeviceKey',
  'qrCodeBytes',
  // The bundle's file key (`encryptionInfo`, `mediaEncryptionInfo`).
  'getReceivedRoomKeyBundleData',
  'buildRoomKeyBundle',
]);
const codeOnly = (method: string) =>
  QUIET_METHODS.has(method) || SECRET_ANSWER_METHODS.has(method);
/** A code as the crate writes them; anything else from the bridge is not repeated. */
const safeCode = (code: unknown, fallback: string) =>
  typeof code === 'string' && /^[A-Z][A-Za-z]{0,39}$/.test(code)
    ? code
    : fallback;

/** A batch still waiting after this long is logged, once, whatever its limit. */
export const DEFAULT_WARN_AFTER_MS = 60_000;
/** Room kept in every batch for the `pollEvents` requests added to it. */
const POLL_RESERVE = 4096;

type EventListener = (events: NativeEvents) => void;
/** `malformed`: the answer was no event list, so nothing it says can be trusted. */
type PollFailure = (reason: string, malformed: boolean) => void;

export interface CallQueueOptions {
  readonly maxBatchLength?: number;
  readonly timeoutMs?: number;
  readonly heavyTimeoutMs?: number;
  readonly slowTimeoutMs?: number;
  readonly warnAfterMs?: number;
  /** Puts the bridge's own error text back into errors of calls not code-only. Never in a release. */
  readonly debugBridgeErrors?: boolean;
  readonly logger?: NativeCryptoLogger;
  /** See `NativeCryptoOptions.trace`. */
  readonly trace?: (line: string) => void;
}

interface Pending {
  /** Emptied of a quiet call's parameters once the batch is with the bridge. */
  request: NativeRequest;
  line: string;
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

const isEvents = (value: unknown): value is NativeEvents =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as NativeEvents).events) &&
  typeof (value as NativeEvents).dropped === 'number';

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
  private readonly listeners = new Map<
    string,
    { events: EventListener; failed?: PollFailure }
  >();
  private readonly logger?: NativeCryptoLogger;
  private batches = 0;

  public constructor(
    private readonly bridge: NativeCryptoBridge,
    private readonly options: CallQueueOptions = {},
  ) {
    this.logger = options.logger;
  }

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
    failed?: PollFailure,
  ): void {
    this.listeners.set(keyOf(machine), { events: listener, failed });
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
      this.logger?.warn(`native crypto batch failed: ${describeError(error)}`),
    );
  }

  /**
   * One batch per machine (in the order the machines were first called), so a stuck machine's
   * timeout loses only its own calls; split at the size cap, a single call over it goes alone.
   */
  private chunks(calls: readonly Pending[]): Pending[][] {
    const budget =
      (this.options.maxBatchLength ?? DEFAULT_MAX_BATCH_LENGTH) - POLL_RESERVE;
    const byMachine = new Map<string, Pending[]>();
    for (const pending of calls) {
      const key = keyOf(pending.request);
      byMachine.set(key, [...(byMachine.get(key) ?? []), pending]);
    }
    return [...byMachine.values()].flatMap((machineCalls) =>
      this.split(machineCalls, budget),
    );
  }

  private split(calls: readonly Pending[], budget: number): Pending[][] {
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

  private timeout(chunk: readonly Pending[]): number {
    const { timeoutMs, heavyTimeoutMs, slowTimeoutMs } = this.options;
    const methods = chunk.map(({ request }) => request.method);
    if (methods.some((method) => SLOW_METHODS.has(method))) {
      return slowTimeoutMs ?? DEFAULT_SLOW_TIMEOUT_MS;
    }
    if (methods.some((method) => HEAVY_METHODS.has(method))) {
      return heavyTimeoutMs ?? DEFAULT_HEAVY_TIMEOUT_MS;
    }
    return timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** The bridge's answer, or a rejection once the batch's time is up. */
  private async exchange(
    answer: Promise<string>,
    ms: number,
    methods: string,
  ): Promise<string> {
    const warnAfter = this.options.warnAfterMs ?? DEFAULT_WARN_AFTER_MS;
    const warning =
      ms > warnAfter
        ? setTimeout(
            () =>
              this.logger?.warn(
                `native crypto ${methods}: still waiting for the bridge after ${warnAfter} ms`,
              ),
            warnAfter,
          )
        : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimedOut()), ms);
    });
    try {
      return await Promise.race([answer, late]);
    } finally {
      clearTimeout(timer);
      clearTimeout(warning);
    }
  }

  private async send(chunk: readonly Pending[]): Promise<void> {
    const items = this.wire(chunk);
    const calls = items.flatMap((item) =>
      item.kind === 'call' ? [item.pending] : [],
    );
    const lines = items.map((item) =>
      item.kind === 'call' ? item.pending.line : item.line,
    );
    // Debug text only for a batch none of whose calls is code-only.
    const debug =
      this.options.debugBridgeErrors === true &&
      !calls.some(({ request }) => codeOnly(request.method));
    const single = lines.length === 1;
    const methods = [
      ...new Set(calls.map(({ request }) => request.method)),
    ].join(', ');
    const timeout = this.timeout(chunk);
    const batch = ++this.batches;
    const machine = chunk[0] ? keyOf(chunk[0].request) : '';
    this.options.trace?.(
      `batch ${batch} ${machine} ${calls.map(({ request }) => request.method).join(' ')}${items.length > calls.length ? ' +poll' : ''}`,
    );
    // The text goes straight to the bridge, which is then the queue's only holder of its secrets.
    let answer: Promise<string>;
    try {
      answer = single
        ? this.bridge.call(lines[0])
        : this.bridge.callBatch(`[${lines.join(',')}]`);
    } catch (error) {
      answer = Promise.reject(error);
    }
    lines.length = 0;
    for (const pending of calls) {
      if (QUIET_METHODS.has(pending.request.method)) {
        const { method, userId, deviceId } = pending.request;
        pending.request = { method, userId, deviceId };
        pending.line = '';
      }
    }
    let responses: unknown;
    try {
      responses = JSON.parse(await this.exchange(answer, timeout, methods));
    } catch (cause) {
      const timedOut = cause instanceof TimedOut;
      const kind = timedOut
        ? 'timedOut'
        : cause instanceof SyntaxError
          ? 'malformed'
          : 'failed';
      const what = {
        timedOut: 'timed out',
        malformed: 'answered something that is not JSON',
        failed: 'failed',
      }[kind];
      const detail = debug && !timedOut ? `: ${describeError(cause)}` : '';
      for (const { request, reject } of calls) {
        reject(
          new NativeBridgeError(
            `native crypto ${request.method}: the bridge ${what}${detail}`,
            kind,
            debug ? { cause } : undefined,
          ),
        );
      }
      return;
    }
    const answers = single ? [responses] : responses;
    if (
      !Array.isArray(answers) ||
      answers.length !== items.length ||
      !answers.every(isResponse)
    ) {
      const refusal = isResponse(responses) ? responses.error : undefined;
      for (const { request, reject } of calls) {
        reject(
          refusal
            ? new NativeCryptoError(
                request.method,
                safeCode(refusal.code, 'BridgeRefused'),
                debug && typeof refusal.message === 'string'
                  ? `the bridge refused the batch: ${refusal.message}`
                  : 'the bridge refused the batch',
              )
            : new NativeBridgeError(
                `native crypto ${request.method}: the bridge answered something other than the batch`,
                'malformed',
              ),
        );
      }
      return;
    }
    items.forEach((item, index) => {
      if (item.kind !== 'poll') return;
      const answer = answers[index];
      const listener = this.listeners.get(item.key);
      try {
        if (answer.error) {
          listener?.failed?.(
            `native crypto pollEvents failed (${safeCode(answer.error.code, 'Refused')})`,
            false,
          );
        } else if (!isEvents(answer.result)) {
          listener?.failed?.(
            'native crypto pollEvents answered an unexpected shape',
            true,
          );
        } else {
          if (this.options.trace && answer.result.events.length > 0)
            this.options.trace(
              `events ${batch} ${item.key} ${answer.result.events.map(describeEvent).join(' | ')} dropped=${answer.result.dropped}`,
            );
          listener?.events(answer.result);
        }
      } catch (error) {
        this.logger?.warn(
          `native crypto events were not delivered: ${describeError(error)}`,
        );
      }
    });
    items.forEach((item, index) => {
      if (item.kind !== 'call') return;
      const answer = answers[index];
      if (answer.error) {
        const { code, message, details } = answer.error;
        const method = item.pending.request.method;
        item.pending.reject(
          codeOnly(method)
            ? new NativeCryptoError(
                method,
                safeCode(code, 'Refused'),
                'refused (the message is withheld for this call)',
              )
            : new NativeCryptoError(
                method,
                safeCode(code, 'Refused'),
                typeof message === 'string' ? message : 'refused',
                details,
              ),
        );
      } else {
        item.pending.resolve(answer.result);
      }
    });
  }
}

class TimedOut extends Error {}

/** An event for the trace: its type, and a verification's flow and state, nothing else. */
function describeEvent(event: NativeEvents['events'][number]): string {
  if (typeof event !== 'object' || event === null) return 'malformed';
  const object = event['request'] ?? event['verification'];
  if (typeof object !== 'object' || object === null) return event.type;
  const fields = object as Record<string, unknown>;
  const state = ['kind', 'phase', 'state', 'isDone', 'isCancelled']
    .filter((name) => fields[name] !== undefined)
    .map((name) => `${name}=${String(fields[name])}`)
    .concat(fields['decimals'] === undefined ? [] : ['shown'])
    .join(',');
  return `${event.type}(${String(fields['flowId'])} ${state})`;
}
