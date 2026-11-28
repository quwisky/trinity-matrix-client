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
  /** Called when the crate dropped events because the shim fell behind. */
  readonly onEventsDropped?: (dropped: number) => void;
  /** The size cap of one batch, in characters of JSON. */
  readonly maxBatchLength?: number;
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
