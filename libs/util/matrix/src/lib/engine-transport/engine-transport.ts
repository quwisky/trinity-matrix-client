import type { Observable } from 'rxjs';
import type { Fault } from './rust-dto/Fault';

export type { Fault } from './rust-dto/Fault';
export type { Frame } from './rust-dto/Frame';
export type { Inbound } from './rust-dto/Inbound';

/** Carries engine calls as frames to an engine in another runtime. */
export interface EngineTransport {
  /**
   * A cold stream of the values `method` emits, erroring with an {@link EngineFaultError}.
   * `args` may hold Blobs at any depth; each transport carries them its own way.
   */
  open(method: string, args: readonly unknown[]): Observable<unknown>;
}

/**
 * A fault of the engine or the protocol, as opposed to an expected engine failure. The message
 * leaves the diagnostic out, since a fallback can show the message to the user.
 */
export class EngineFaultError extends Error {
  constructor(readonly fault: Fault) {
    super(`engine fault: ${fault.code}`);
    this.name = 'EngineFaultError';
  }
}

/**
 * Names that `await`, `JSON.stringify`, RxJS `from()` and `isObservable()` and Angular's injector
 * probe for. As members they would make the engine look like a promise, a stream or a service to
 * destroy; no engine has one.
 */
const PROBED_NAMES = new Set([
  'then',
  'toJSON',
  '@@observable',
  'getReader',
  'subscribe',
  'lift',
  'ngOnDestroy',
]);

/** `T` whose every member call opens `name.member` on `transport` with the call's arguments. */
export function proxyEngine<T extends object>(
  name: string,
  transport: EngineTransport,
): T {
  return new Proxy({} as T, {
    // Symbols, probed names and `Object.prototype` members (`toString`…) keep plain-object behaviour.
    get: (target, member) =>
      typeof member === 'symbol' || PROBED_NAMES.has(member) || member in target
        ? Reflect.get(target, member)
        : (...args: unknown[]) => transport.open(`${name}.${member}`, args),
  });
}

/** A Blob's place in an argument, as `BlobRefDto` names it on the wire. */
function blobRef(index: number) {
  return { $blob: index };
}

/** Any object with an `arrayBuffer` method: a `File`, or a Blob from another realm such as jsdom's. */
function isBlob(value: unknown): value is Blob {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function'
  );
}

/**
 * `args` with each Blob, at any depth, replaced by `{ $blob: n }`, an index into `blobs` in
 * walk order. A subtree without a Blob is returned as it is; reads no bytes.
 */
export function extractBlobs(args: readonly unknown[]): {
  readonly args: unknown[];
  readonly blobs: readonly Blob[];
} {
  const blobs: Blob[] = [];
  const walk = (value: unknown): unknown => {
    if (isBlob(value)) {
      blobs.push(value);
      return blobRef(blobs.length - 1);
    }
    if (typeof value !== 'object' || value === null) {
      return value;
    }
    const entries = Object.entries(value);
    const walked = entries.map(([key, child]) => [key, walk(child)] as const);
    if (walked.every(([, child], at) => child === entries[at]?.[1])) {
      return value;
    }
    // fromEntries defines own keys, so an own `__proto__` stays a key.
    return Array.isArray(value)
      ? walked.map(([, child]) => child)
      : Object.fromEntries(walked);
  };
  return { args: args.map(walk), blobs };
}
