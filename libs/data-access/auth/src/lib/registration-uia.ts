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
  return Object.entries(policies).flatMap(([id, rawPolicy]) => {
    if (
      !rawPolicy ||
      typeof rawPolicy !== 'object' ||
      Array.isArray(rawPolicy)
    ) {
      return [];
    }
    const policy = rawPolicy as Record<string, unknown>;
    const localized =
      localizedPolicy(policy['en']) ??
      Object.values(policy)
        .map((value) => localizedPolicy(value))
        .find((value) => value !== null) ??
      null;
    if (!localized) return [];
    return [
      {
        id,
        name: localized.name,
        url: localized.url,
        version: typeof policy['version'] === 'string' ? policy['version'] : '',
      },
    ];
  });
}

/** Validate the auto-login fields and translate the relative token lifetime. */
export function authenticatedRegistrationResponse(response: RegisterResponse) {
  if (!response.user_id || !response.access_token || !response.device_id) {
    throw new RegistrationSessionError(
      'The homeserver created the account but did not return a login session.',
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
