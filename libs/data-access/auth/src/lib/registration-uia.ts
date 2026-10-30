import {
  EngineRequestError,
  type EngineFailure,
  type UiaChallenge,
} from '@trinity/util/matrix';
import { isValidDeviceId, userIdServerName } from './account-establishment';
import type { RegisteredAccount } from './auth-engine';

export const DUMMY_STAGE = 'm.login.dummy';
export const TERMS_STAGE = 'm.login.terms';
export const EMAIL_STAGE = 'm.login.email.identity';
export const REGISTRATION_TOKEN_STAGES = new Set<string>([
  'm.login.registration_token',
  'org.matrix.msc3231.login.registration_token',
]);
const NATIVE_REGISTRATION_STAGES = new Set<string>([
  DUMMY_STAGE,
  TERMS_STAGE,
  EMAIL_STAGE,
  ...REGISTRATION_TOKEN_STAGES,
]);
const REGISTRATION_PROBE_PREFIX = 'trinity';

export type RegistrationAvailability = 'open' | 'closed' | 'unknown';

export interface RegistrationPolicy {
  id: string;
  name: string;
  url: string;
  version: string;
}

export type RegistrationStage =
  | { kind: 'idle' }
  | { kind: 'credentials' }
  | { kind: 'email-address' }
  | { kind: 'email-verification'; sent: boolean; message?: string }
  | { kind: 'terms'; policies: readonly RegistrationPolicy[]; message?: string }
  | {
      kind: 'registration-token';
      authType: string;
      message?: string;
    }
  | { kind: 'fallback'; authType: string; url: string; message?: string }
  | {
      kind: 'session-error';
      userId: string;
      retryable: boolean;
    };

/** A registration challenge that names its session and at least one flow of stages. */
export interface RegistrationChallenge extends UiaChallenge {
  readonly session: string;
}

export interface ExpectedRegistrationIdentity {
  localpart: string;
  serverName: string;
}

/** Short, conservative lowercase-alphanumeric localpart for the availability endpoint. */
export function registrationProbeLocalpart(): string {
  // Homeservers may impose restrictions beyond Matrix's grammar. Six random bytes
  // still make accidental occupancy negligible without relying on underscores or length.
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return (
    REGISTRATION_PROBE_PREFIX +
    Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  );
}

/** Strip an optional MXID down to the username sent to registration. */
export function registrationLocalpart(username: string): string {
  const trimmed = username.trim().replace(/^@/, '');
  const colon = trimmed.indexOf(':');
  return colon >= 0 ? trimmed.slice(0, colon) : trimmed;
}

/** The server text on a refused step, from either failure that can carry it. */
export function serverMessageOf(failure: EngineFailure): string | undefined {
  return failure.code === 'request-failed' || failure.code === 'uia-required'
    ? failure.params?.serverMessage
    : undefined;
}

export function registrationErrorMessage(error: unknown): string {
  if (error instanceof EngineRequestError) {
    const { failure } = error;
    return (
      serverMessageOf(failure) ??
      (failure.diagnostic.errcode
        ? 'The homeserver rejected this registration step.'
        : error.message)
    );
  }
  return error instanceof Error ? error.message : 'Registration failed.';
}

/** Check and defensively clone the challenge that opens a registration. */
export function readRegistrationUiaChallenge(
  challenge: UiaChallenge,
): RegistrationChallenge {
  const { session, flows } = challenge;
  if (
    typeof session !== 'string' ||
    session.length === 0 ||
    !Array.isArray(flows) ||
    flows.length === 0 ||
    flows.some(
      (flow) =>
        !flow ||
        !Array.isArray(flow.stages) ||
        flow.stages.length === 0 ||
        flow.stages.some((stage: unknown) => typeof stage !== 'string'),
    )
  ) {
    throw new Error(
      'The homeserver returned an invalid registration UIA challenge.',
    );
  }
  return {
    ...challenge,
    session,
    flows: flows.map((flow) => ({ stages: [...flow.stages] })),
  };
}

/** Prefer flows fully handled in-app, then the shortest remaining hosted fallback. */
export function chooseRegistrationFlow(
  flows: UiaChallenge['flows'],
): readonly string[] {
  return [...flows].sort((left, right) => {
    const unsupportedDifference =
      left.stages.filter((stage) => !NATIVE_REGISTRATION_STAGES.has(stage))
        .length -
      right.stages.filter((stage) => !NATIVE_REGISTRATION_STAGES.has(stage))
        .length;
    return unsupportedDifference || left.stages.length - right.stages.length;
  })[0].stages;
}

/** Reduce untrusted homeserver policy metadata to safe, plain-text external links. */
export function readRegistrationPolicies(
  params: unknown,
): RegistrationPolicy[] {
  const policies =
    params && typeof params === 'object' && 'policies' in params
      ? params.policies
      : undefined;
  if (!policies || typeof policies !== 'object' || Array.isArray(policies)) {
    return [];
  }
  const entries = Object.entries(policies);
  if (entries.length === 0) return [];
  const parsed: RegistrationPolicy[] = [];
  for (const [id, rawPolicy] of entries) {
    if (
      id.length === 0 ||
      !rawPolicy ||
      typeof rawPolicy !== 'object' ||
      Array.isArray(rawPolicy)
    ) {
      return [];
    }
    const policy = rawPolicy as Record<string, unknown>;
    if (
      typeof policy['version'] !== 'string' ||
      policy['version'].length === 0
    ) {
      return [];
    }
    const localized =
      localizedPolicy(policy['en']) ??
      Object.values(policy)
        .map((value) => localizedPolicy(value))
        .find((value) => value !== null) ??
      null;
    if (!localized) return [];
    parsed.push({
      id,
      name: localized.name,
      url: localized.url,
      version: policy['version'],
    });
  }
  return parsed;
}

/** Validate the auto-login fields and translate the relative token lifetime. */
export function authenticatedRegistrationResponse(
  response: RegisteredAccount,
  expected: ExpectedRegistrationIdentity,
) {
  if (
    !nonEmptyString(response.userId) ||
    !nonEmptyString(response.accessToken) ||
    !nonEmptyString(response.deviceId) ||
    !isValidDeviceId(response.deviceId) ||
    (response.refreshToken !== null &&
      !nonEmptyString(response.refreshToken)) ||
    (response.expiresInMs !== null &&
      (!Number.isFinite(response.expiresInMs) || response.expiresInMs < 0))
  ) {
    throw new RegistrationSessionError(
      'The homeserver created the account but did not return a login session.',
      false,
    );
  }
  const mxid = /^@([^:]+):(.+)$/.exec(response.userId);
  if (
    !mxid ||
    userIdServerName(response.userId) === null ||
    mxid[1].toLocaleLowerCase() !== expected.localpart.toLocaleLowerCase() ||
    mxid[2].toLocaleLowerCase() !== expected.serverName.toLocaleLowerCase()
  ) {
    throw new RegistrationSessionError(
      'The homeserver returned an account identity that did not match this registration.',
      false,
    );
  }
  return {
    user_id: response.userId,
    access_token: response.accessToken,
    device_id: response.deviceId,
    ...(response.refreshToken ? { refresh_token: response.refreshToken } : {}),
    ...(response.expiresInMs !== null
      ? { accessTokenExpiresAt: Date.now() + response.expiresInMs }
      : {}),
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export class RegistrationSessionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function localizedPolicy(value: unknown): { name: string; url: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const localized = value as Record<string, unknown>;
  if (
    typeof localized['name'] !== 'string' ||
    localized['name'].length === 0 ||
    typeof localized['url'] !== 'string' ||
    !isSafeExternalUrl(localized['url'])
  ) {
    return null;
  }
  return { name: localized['name'], url: localized['url'] };
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
