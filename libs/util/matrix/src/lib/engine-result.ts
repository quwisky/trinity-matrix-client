import {
  BehaviorSubject,
  type Observable,
  type OperatorFunction,
  filter,
  firstValueFrom,
  map,
  timeout,
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

/**
 * Why a recovery or key-file import was refused: no secret storage to recover from, text
 * that is not a recovery key, secret storage not set up from a passphrase, or a key or
 * passphrase that does not unlock.
 */
export type RecoveryRefusal =
  'not-configured' | 'malformed-key' | 'no-passphrase' | 'incorrect';

const RECOVERY_REFUSAL_MESSAGES: Readonly<Record<RecoveryRefusal, string>> = {
  'not-configured': 'No recovery key is set up on this account.',
  'malformed-key': 'That does not look like a valid recovery key.',
  'no-passphrase': 'This account has no recovery passphrase.',
  incorrect: 'That key or passphrase is incorrect.',
};

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
  /** The account has not joined the room. */
  | { readonly code: 'room-unavailable' }
  /** The room state or this device's crypto store already has the room encrypted. */
  | { readonly code: 'already-encrypted' }
  /** The server has `m.room.encryption`, but this device could not apply it. */
  | { readonly code: 'encryption-not-applied' }
  /** The account is live but its crypto has not started. */
  | { readonly code: 'crypto-not-ready' }
  /** The verification flow is unknown, replaced or already over. */
  | { readonly code: 'verification-gone' }
  /** No QR code can be shown for this verification. */
  | { readonly code: 'qr-unavailable' }
  /** The person cancelled a password prompt, or stopped the command that raised it. */
  | { readonly code: 'uia-cancelled' }
  /** The server asks for an authentication stage other than a password. */
  | { readonly code: 'uia-unsupported' }
  /** The server rejected every allowed password attempt. */
  | { readonly code: 'uia-attempts-exceeded' }
  /** No open password prompt has this id: it was answered, cancelled or never raised. */
  | { readonly code: 'prompt-gone' }
  /** A recovery or key-file import refused what it was given; nothing changed. */
  | {
      readonly code: 'recovery-refused';
      readonly params: { readonly reason: RecoveryRefusal };
    }
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
    case 'room-unavailable':
      return 'This room is unavailable.';
    case 'already-encrypted':
      return 'This room is already encrypted.';
    case 'encryption-not-applied':
      return "Encryption is on, but this device couldn't apply it.";
    case 'crypto-not-ready':
      return 'Encryption is not ready for this account yet.';
    case 'verification-gone':
      return 'This verification is no longer in progress.';
    case 'qr-unavailable':
      return 'QR verification isn’t available for these sessions.';
    case 'uia-cancelled':
      return 'Password confirmation was cancelled.';
    case 'uia-unsupported':
      return 'This account needs additional verification that Trinity can’t complete here.';
    case 'uia-attempts-exceeded':
      return 'Too many password attempts.';
    case 'prompt-gone':
      return 'This password prompt is no longer open.';
    case 'recovery-refused':
      return RECOVERY_REFUSAL_MESSAGES[failure.params.reason];
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

/** A feed subscribed by {@link recordFeed}. */
export interface FeedRecording<T> {
  /** Every item so far, in order. */
  readonly items: readonly T[];
  /** The first item, already recorded or later, that matches; rejects on a breach or timeout. */
  until(predicate: (item: T) => boolean, timeoutMs: number): Promise<T>;
  unsubscribe(): void;
}

/**
 * Subscribes to a feed: a subscription with no snapshot and no replay, whose items are plain
 * data and which neither completes nor errors. Throws a TypeError when it emits, completes or
 * errors on subscribe; a later breach rejects every `until`.
 */
export function recordFeed<T>(source: Observable<T>): FeedRecording<T> {
  const items: T[] = [];
  const changes = new BehaviorSubject<void>(undefined);
  let breach: TypeError | null = null;
  let subscribing = true;
  const fail = (message: string): void => {
    breach ??= new TypeError(message);
    changes.next();
  };
  const subscription = source.subscribe({
    next: (item) => {
      if (subscribing)
        return fail('Emitted on subscribe: a feed has no snapshot');
      try {
        assertPlainData(item, `$[${items.length}]`);
      } catch (error) {
        return fail((error as Error).message);
      }
      items.push(item);
      changes.next();
    },
    error: () => fail('The feed errored'),
    complete: () => fail('The feed completed'),
  });
  subscribing = false;
  if (breach) {
    subscription.unsubscribe();
    throw breach;
  }
  return {
    items,
    until: (predicate, timeoutMs) =>
      firstValueFrom(
        changes.pipe(
          map(() => {
            if (breach) throw breach;
            return items.findIndex(predicate);
          }),
          filter((index) => index !== -1),
          map((index) => items[index]),
          timeout(timeoutMs),
        ),
      ),
    unsubscribe: () => subscription.unsubscribe(),
  };
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
