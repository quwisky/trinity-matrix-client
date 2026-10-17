import type {
  HostOperationOutcome,
  HostPinOutcome,
  HostPinPresence,
  HostPresenceBiometry,
  HostPresenceOutcome,
  HostSystemPresence,
  HostSystemPresenceUnavailableReason,
  HostUnavailableReason,
  HostUserPresenceSupport,
} from '@trinity/runtime/host';

/** The PIN half for a host with no PIN store (no plugin, no usable encryption, the web). */
export const NO_PIN_STORE: HostPinPresence = {
  kind: 'unavailable',
  reason: 'not-supported',
};

/**
 * A PIN store the host cannot read, or an answer about it that cannot be trusted: never
 * "available, not set" nor "no PIN store" (fail closed).
 */
export const PIN_STORE_UNREADABLE: HostPinPresence = {
  kind: 'unavailable',
  reason: 'secure-storage-unavailable',
};

const BIOMETRIES: readonly HostPresenceBiometry[] = [
  'face',
  'fingerprint',
  'touch-id',
  'windows-hello',
  'passcode-only',
];
const SYSTEM_UNAVAILABLE: readonly HostSystemPresenceUnavailableReason[] = [
  'not-supported',
  'no-device-credential',
  'not-enrolled',
  'not-configured',
  'disabled-by-policy',
  'windows-version',
  'addon-unavailable',
  'locked-out',
];
const MALFORMED: HostPresenceOutcome = {
  kind: 'rejected',
  diagnostic: { code: 'electron-malformed-response' },
};

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function systemOf(raw: unknown): HostSystemPresence {
  const kind = field(raw, 'kind');
  const biometry = field(raw, 'biometry');
  const reason = field(raw, 'reason');
  if (
    kind === 'available' &&
    BIOMETRIES.includes(biometry as HostPresenceBiometry)
  ) {
    // The desktop shell reports Touch ID only on a Mac, whose sheet offers the account password.
    return biometry === 'touch-id'
      ? { kind, biometry, fallback: 'password' }
      : {
          kind,
          biometry: biometry as Exclude<HostPresenceBiometry, 'touch-id'>,
        };
  }
  if (
    kind === 'unavailable' &&
    SYSTEM_UNAVAILABLE.includes(reason as HostSystemPresenceUnavailableReason)
  ) {
    return { kind, reason: reason as HostSystemPresenceUnavailableReason };
  }
  return { kind: 'unavailable', reason: 'not-supported' };
}

/** Only an explicit "no PIN store" reads as one; anything garbled fails closed. */
function pinOf(raw: unknown): HostPinPresence {
  const kind = field(raw, 'kind');
  const next = field(raw, 'nextAttemptAt');
  if (
    kind === 'available' &&
    typeof field(raw, 'set') === 'boolean' &&
    (next === null || (typeof next === 'number' && Number.isFinite(next)))
  ) {
    return {
      kind,
      set: field(raw, 'set') as boolean,
      nextAttemptAt: next as number | null,
    };
  }
  if (
    kind === 'unavailable' &&
    field(raw, 'reason') === 'secure-storage-unavailable'
  ) {
    return { kind, reason: 'secure-storage-unavailable' };
  }
  if (kind === 'unavailable' && field(raw, 'reason') === 'not-supported') {
    return NO_PIN_STORE;
  }
  return PIN_STORE_UNREADABLE;
}

/**
 * Support as the shell reported it, validated. An unknown system half means "no system
 * prompt"; an unknown PIN half means "PIN store unreadable", so a bad answer fails closed.
 */
export function parseUserPresenceSupport(
  raw: unknown,
): HostUserPresenceSupport {
  return {
    system: systemOf(field(raw, 'system')),
    pin: pinOf(field(raw, 'pin')),
  };
}

/** A prompt outcome from the shell, validated; only stable fields survive. */
export function parsePresenceOutcome(raw: unknown): HostPresenceOutcome {
  const kind = field(raw, 'kind');
  switch (kind) {
    case 'verified':
    case 'cancelled':
    case 'failed':
    case 'locked-out':
      return { kind };
    case 'unavailable': {
      const reason = field(raw, 'reason');
      return SYSTEM_UNAVAILABLE.includes(
        reason as HostSystemPresenceUnavailableReason,
      )
        ? { kind, reason: reason as HostSystemPresenceUnavailableReason }
        : MALFORMED;
    }
    case 'rejected': {
      const code = field(field(raw, 'diagnostic'), 'code');
      return typeof code === 'string' && /^[a-z0-9-]{1,64}$/.test(code)
        ? { kind, diagnostic: { code } }
        : MALFORMED;
    }
    default:
      return MALFORMED;
  }
}

const MALFORMED_PIN: HostPinOutcome = {
  kind: 'rejected',
  diagnostic: { code: 'electron-malformed-response' },
};
const UNAVAILABLE_REASONS: readonly HostUnavailableReason[] = [
  'not-implemented',
  'not-supported',
  'protocol-mismatch',
  'host-rejected',
];

function instantOrNull(value: unknown): value is number | null {
  return (
    value === null || (typeof value === 'number' && Number.isFinite(value))
  );
}

function diagnosticCode(raw: unknown): string | null {
  const code = field(field(raw, 'diagnostic'), 'code');
  return typeof code === 'string' && /^[a-z0-9-]{1,64}$/.test(code)
    ? code
    : null;
}

/** A PIN outcome from the shell, validated; only stable fields survive. */
export function parsePinOutcome(raw: unknown): HostPinOutcome {
  const kind = field(raw, 'kind');
  const next = field(raw, 'nextAttemptAt');
  switch (kind) {
    case 'verified':
    case 'invalid':
    case 'unavailable':
      return { kind };
    case 'failed':
      return instantOrNull(next)
        ? { kind, nextAttemptAt: next }
        : MALFORMED_PIN;
    case 'delayed':
      return typeof next === 'number' && Number.isFinite(next)
        ? { kind, nextAttemptAt: next }
        : MALFORMED_PIN;
    case 'rejected': {
      const code = diagnosticCode(raw);
      return code ? { kind, diagnostic: { code } } : MALFORMED_PIN;
    }
    default:
      return MALFORMED_PIN;
  }
}

/** A PIN command's outcome from the shell; an unknown shape is malformed, not "none". */
export function parseCommandOutcome(raw: unknown): HostOperationOutcome {
  const kind = field(raw, 'kind');
  const reason = field(raw, 'reason');
  const code = diagnosticCode(raw);
  if (kind === 'completed') return { kind };
  if (
    kind === 'unavailable' &&
    UNAVAILABLE_REASONS.includes(reason as HostUnavailableReason)
  ) {
    return { kind, reason: reason as HostUnavailableReason };
  }
  if (kind === 'rejected' && code) return { kind, diagnostic: { code } };
  return {
    kind: 'rejected',
    diagnostic: { code: 'electron-malformed-response' },
  };
}
