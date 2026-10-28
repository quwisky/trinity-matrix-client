import {
  type Observable,
  type OperatorFunction,
  firstValueFrom,
  map,
  toArray,
} from 'rxjs';
import {
  type MatrixRequestFailureKind,
  type MatrixRequestFailureMetadata,
  requestFailureMessage,
} from './request-failure';

export type EngineFailureCode = EngineFailure['code'];

/** Why homeserver discovery failed; one member per SDK `AutoDiscoveryError` the path can produce. */
export type DiscoveryFailureReason =
  | 'invalid'
  | 'generic-failure'
  | 'invalid-hs-base-url'
  | 'invalid-homeserver'
  | 'unsupported-homeserver-spec-version'
  | 'missing-wellknown'
  | 'invalid-json';

/** Why a persisted account could not start; mirrors the matrix-client startup outcomes. */
export type AccountStartFailureReason =
  | 'reauthentication-required'
  | 'transient-network'
  | 'crypto-failure'
  | 'crypto-store-key-lost'
  | 'secure-storage-unavailable';

/** A failure as plain data: a code and parameters, never text. See {@link engineFailureMessage}. */
export type EngineFailure = {
  readonly kind: MatrixRequestFailureKind;
  readonly diagnostic: MatrixRequestFailureMetadata;
} & (
  | { readonly code: 'not-signed-in' }
  | {
      readonly code: 'discovery-failed';
      readonly params: {
        readonly domain: string;
        readonly reason?: DiscoveryFailureReason;
      };
    }
  | {
      readonly code: 'request-failed';
      /** `session-refresh` marks a failed token refresh, worded apart from a plain network failure. */
      readonly params?: { readonly cause?: 'session-refresh' };
    }
  | {
      readonly code: 'account-start-failed';
      readonly params: { readonly reason: AccountStartFailureReason };
    }
  | { readonly code: 'account-not-live' }
  | { readonly code: 'invite-blocked' }
  | { readonly code: 'unsupported' }
  | { readonly code: 'message-unavailable' }
  /** The send may already have left the device. */
  | { readonly code: 'not-cancellable' }
  | { readonly code: 'not-forwardable' }
  /** The room is encrypted and the account has no crypto to encrypt with. */
  | { readonly code: 'encryption-unavailable' }
  | { readonly code: 'forbidden' }
  /** The target changed since the revision the caller confirmed. */
  | { readonly code: 'conflict' }
  | { readonly code: 'state-key-taken' }
  /** No source to fetch, or the bytes failed their hash check. */
  | { readonly code: 'media-unavailable' }
  /** The homeserver refused the upload as over its size limit. */
  | { readonly code: 'too-large' }
  /** The account has no such room. */
  | { readonly code: 'conversation-unavailable' }
);

const DISCOVERY_REASON_MESSAGES: Readonly<
  Record<DiscoveryFailureReason, string>
> = {
  invalid: 'Invalid homeserver discovery response',
  'generic-failure': 'Failed to get autodiscovery configuration from server',
  'invalid-hs-base-url': 'Invalid base_url for m.homeserver',
  'invalid-homeserver':
    'Homeserver URL does not appear to be a valid Matrix homeserver',
  'unsupported-homeserver-spec-version':
    'The homeserver does not meet the version requirements',
  'missing-wellknown': 'No .well-known JSON file found',
  'invalid-json': 'Invalid JSON',
};

/** The one table of user-facing text for engine failures. */
export function engineFailureMessage(failure: EngineFailure): string {
  switch (failure.code) {
    case 'not-signed-in':
      return 'Not signed in.';
    case 'discovery-failed': {
      const { domain, reason } = failure.params;
      return reason && Object.hasOwn(DISCOVERY_REASON_MESSAGES, reason)
        ? DISCOVERY_REASON_MESSAGES[reason]
        : `Could not discover a homeserver for "${domain}".`;
    }
    case 'request-failed':
      return requestFailureMessage(failure.kind, {
        ...failure.diagnostic,
        cause: failure.params?.cause,
      });
    case 'account-start-failed':
    case 'account-not-live':
    case 'invite-blocked':
    case 'unsupported':
    case 'not-cancellable':
      return requestFailureMessage(failure.kind, failure.diagnostic);
    case 'message-unavailable':
      return 'Message not found.';
    case 'not-forwardable':
      return 'This message cannot be forwarded.';
    case 'encryption-unavailable':
      return 'Encryption is unavailable.';
    case 'forbidden':
      return 'You do not have permission to do that.';
    case 'conflict':
      return 'This changed before it could be saved. Review it and try again.';
    case 'state-key-taken':
      return 'That identifier is already in use.';
    case 'media-unavailable':
      return 'This media is unavailable.';
    case 'too-large':
      return 'This file is too large to upload.';
    case 'conversation-unavailable':
      return 'This conversation is unavailable.';
  }
}

const RETRYABLE_KINDS: ReadonlySet<MatrixRequestFailureKind> = new Set([
  'network',
  'timeout',
  'rate-limit',
  'server',
]);

/** Whether trying the same request again later may succeed. */
export function retryableFailure(failure: EngineFailure): boolean {
  return RETRYABLE_KINDS.has(failure.kind);
}

/** Outcome of an engine command: expected failures are values, faults error the stream. */
export type EngineResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: EngineFailure };

export function engineOk<T>(value: T): EngineResult<T> {
  return { ok: true, value };
}

export function engineFail(failure: EngineFailure): EngineResult<never> {
  return { ok: false, failure };
}

export const NOT_SIGNED_IN: EngineFailure = {
  kind: 'unexpected',
  code: 'not-signed-in',
  diagnostic: { kind: 'unexpected' },
};

/** Carries an engine failure through code that expects a thrown error. */
export class EngineRequestError extends Error {
  constructor(readonly failure: EngineFailure) {
    super(engineFailureMessage(failure));
    this.name = 'EngineRequestError';
  }
}

export function unwrapEngineResult<T>(): OperatorFunction<EngineResult<T>, T> {
  return map((result) => {
    if (!result.ok) throw new EngineRequestError(result.failure);
    return result.value;
  });
}

/** Throws a TypeError naming the first value that could not cross an engine boundary. */
export function assertPlainData(value: unknown, path = '$'): void {
  if (value === null) return;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (Number.isFinite(value)) return;
      break;
    case 'object': {
      if (Array.isArray(value)) {
        value.forEach((item, i) => assertPlainData(item, `${path}[${i}]`));
        return;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto === Object.prototype || proto === null) {
        for (const [key, item] of Object.entries(value)) {
          assertPlainData(item, `${path}.${key}`);
        }
        return;
      }
      break;
    }
  }
  throw new TypeError(`Not plain data at ${path}`);
}

/**
 * Collects a progress command: zero or more `progress` updates, then exactly one `done`,
 * then completion, each update plain data. Rejects with a TypeError naming the first breach.
 */
export async function assertProgressThenResult<
  P extends { readonly kind: 'progress' },
  R,
>(
  source: Observable<P | { readonly kind: 'done'; readonly result: R }>,
): Promise<{ readonly progress: readonly P[]; readonly result: R }> {
  const updates = await firstValueFrom(source.pipe(toArray()));
  updates.forEach((update, i) => assertPlainData(update, `$[${i}]`));
  const last = updates.at(-1);
  if (last?.kind !== 'done') {
    throw new TypeError('Completed without a done update');
  }
  const progress = updates.slice(0, -1);
  const early = progress.findIndex((update) => update.kind !== 'progress');
  if (early !== -1) {
    throw new TypeError(`Update ${early} is not progress before the one done`);
  }
  return { progress: progress as P[], result: last.result };
}

/** Structural equality for plain data (see {@link assertPlainData}): objects, arrays and primitives. */
export function plainEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return false;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && plainEqual(left[key], right[key]),
    )
  );
}
