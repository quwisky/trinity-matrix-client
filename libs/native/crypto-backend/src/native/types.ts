/**
 * The native crypto crate's call surface as a host reaches it: `call` takes one request
 * as JSON and answers one response; `callBatch` takes a JSON array and answers an array in
 * the same order (native/crypto/README.md). A rejection means the bridge itself failed.
 */
export interface NativeCryptoBridge {
  call(request: string): Promise<string>;
  callBatch(requests: string): Promise<string>;
}

export interface NativeCryptoLogger {
  warn(...args: unknown[]): void;
}

export interface NativeCryptoOptions {
  readonly bridge: NativeCryptoBridge;
  /** Where `StoreHandle.openWithKey` keeps its stores, one directory per store name. */
  readonly storeDirectory?: string;
  readonly logger?: NativeCryptoLogger;
  /**
   * Called when the shim may have missed events: the crate dropped `dropped` of them, or a
   * poll failed (`undefined`: unknown how many).
   */
  readonly onEventsDropped?: (dropped: number | undefined) => void;
  /**
   * Called once when a machine is lost (the bridge failed or timed out, or the crate dropped
   * the machine and `init` could not reload it). Its sync input calls never settle from then
   * on, so matrix-js-sdk cannot move past to-device events it never processed: the host must
   * stop the client.
   */
  readonly onMachineLost?: (reason: string) => void;
  /**
   * Diagnostics: one line per batch sent, per poll's events and per verification mirror change
   * (method names, flow IDs, phases and states; never parameters or answers). Off unless set;
   * the SDK test bed sets it with `NATIVE_CRYPTO_TRACE`.
   */
  readonly trace?: (line: string) => void;
  /**
   * Puts the bridge's own error text (which may quote requests and answers) back into the
   * errors of calls that carry no secret. For local diagnosis only; never enable it in a release
   * build.
   */
  readonly debugBridgeErrors?: boolean;
  /** The size cap of one batch, in characters of JSON. */
  readonly maxBatchLength?: number;
  /** How long a batch may take before its machines are lost, in milliseconds (60 s). */
  readonly timeoutMs?: number;
  /** The same for a batch holding a sync input, `shareRoomKey`, `markRequestAsSent` or `getMissingSessions` (5 min). */
  readonly heavyTimeoutMs?: number;
  /** The same for a batch holding `init` or a room key export or import (10 min). */
  readonly slowTimeoutMs?: number;
  /** A batch still waiting after this long is logged once (60 s). */
  readonly warnAfterMs?: number;
}

export interface NativeRequest {
  readonly method: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly params?: Record<string, unknown>;
}

export interface NativeErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export type NativeResponse =
  | { readonly result: unknown; readonly error?: undefined }
  | { readonly error: NativeErrorBody };

export interface NativeEvent {
  readonly type: string;
  readonly [field: string]: unknown;
}

export interface NativeEvents {
  readonly events: readonly NativeEvent[];
  readonly dropped: number;
}

/** A call the crate refused; `code` is the crate's error code. */
export class NativeCryptoError extends Error {
  public constructor(
    public readonly method: string,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(`native crypto ${method} failed (${code}): ${message}`);
    this.name = 'NativeCryptoError';
  }
}

/** Why a bridge-level failure happened; its text never carries the bridge's own words. */
export type NativeBridgeFailure = 'failed' | 'timedOut' | 'malformed';

/** The bridge failed, timed out or answered something that is not an answer. */
export class NativeBridgeError extends Error {
  public constructor(
    message: string,
    public readonly kind: NativeBridgeFailure = 'failed',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'NativeBridgeError';
  }
}

/** A call on a machine that is lost (see `onMachineLost`). */
export class NativeMachineLostError extends Error {
  public constructor(method: string) {
    super(`native crypto ${method}: the machine is lost; stop the client`);
    this.name = 'NativeMachineLostError';
  }
}

/** A message for a log line: never the error object, whose `cause` may hold a request. */
export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Fails closed: an answer the crate never gives must not read as a legitimate one. */
export function checked<T>(
  method: string,
  value: unknown,
  valid: (value: unknown) => boolean,
): T {
  if (!valid(value)) {
    throw new NativeCryptoError(
      method,
      'UnexpectedAnswer',
      'unexpected answer from the crate',
    );
  }
  return value as T;
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
