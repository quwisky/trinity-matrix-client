import { type OperatorFunction, map } from 'rxjs';
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
      return requestFailureMessage(failure.kind, failure.diagnostic);
  }
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
