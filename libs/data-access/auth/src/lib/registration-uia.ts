import {
  AuthType,
  MatrixError,
  type IAuthData,
  type RegisterResponse,
  type UIAFlow,
} from 'matrix-js-sdk';

export const EMAIL_STAGE = AuthType.Email;
export const NATIVE_REGISTRATION_STAGES = new Set<string>([
  AuthType.Dummy,
  AuthType.Terms,
  AuthType.Email,
  AuthType.RegistrationToken,
  AuthType.UnstableRegistrationToken,
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

export interface RegistrationUiaData extends IAuthData {
  session: string;
  flows: UIAFlow[];
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

export function registrationErrorMessage(error: unknown): string {
  if (error instanceof MatrixError) {
    return error.error || 'The homeserver rejected this registration step.';
  }
  return error instanceof Error ? error.message : 'Registration failed.';
}

/** Parse and defensively clone a registration UIA challenge. */
export function readRegistrationUiaChallenge(
  error: unknown,
): RegistrationUiaData | null {
  if (!(error instanceof MatrixError) || error.httpStatus !== 401) return null;
  const { session, flows } = error.data;
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
    ...error.data,
    session,
    flows: flows.map((flow) => ({ stages: [...flow.stages] })),
  };
}

/** Prefer flows fully handled in-app, then the shortest remaining hosted fallback. */
export function chooseRegistrationFlow(flows: UIAFlow[]): UIAFlow {
  return [...flows].sort((left, right) => {
    const unsupportedDifference =
      left.stages.filter((stage) => !NATIVE_REGISTRATION_STAGES.has(stage))
        .length -
      right.stages.filter((stage) => !NATIVE_REGISTRATION_STAGES.has(stage))
        .length;
    return unsupportedDifference || left.stages.length - right.stages.length;
  })[0];
}

/** Reduce untrusted homeserver policy metadata to safe, plain-text external links. */
export function readRegistrationPolicies(
  params: Record<string, unknown> | undefined,
): RegistrationPolicy[] {
  const policies = params?.['policies'];
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
  response: RegisterResponse,
  expected: ExpectedRegistrationIdentity,
) {
  if (
    !nonEmptyString(response.user_id) ||
    !nonEmptyString(response.access_token) ||
    !nonEmptyString(response.device_id) ||
    (response.refresh_token !== undefined &&
      !nonEmptyString(response.refresh_token)) ||
    (response.expires_in_ms !== undefined &&
      (!Number.isFinite(response.expires_in_ms) || response.expires_in_ms < 0))
  ) {
    throw new RegistrationSessionError(
      'The homeserver created the account but did not return a login session.',
      false,
    );
  }
  const mxid = /^@([^:]+):(.+)$/.exec(response.user_id);
  if (
    !mxid ||
    mxid[1].toLocaleLowerCase() !== expected.localpart.toLocaleLowerCase() ||
    mxid[2].toLocaleLowerCase() !== expected.serverName.toLocaleLowerCase()
  ) {
    throw new RegistrationSessionError(
      'The homeserver returned an account identity that did not match this registration.',
      false,
    );
  }
  return {
    user_id: response.user_id,
    access_token: response.access_token,
    device_id: response.device_id,
    ...(response.refresh_token
      ? { refresh_token: response.refresh_token }
      : {}),
    ...(response.expires_in_ms !== undefined
      ? { accessTokenExpiresAt: Date.now() + response.expires_in_ms }
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
