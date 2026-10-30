import { MatrixError, type AuthDict } from 'matrix-js-sdk';
import type { UiaAuth, UiaChallenge, UiaResponse } from '@trinity/util/matrix';
import { isRecord } from '../account-start-failure';

/** The challenge a UIA 401 carries (a body with `flows`), else null. */
export function uiaChallengeOf(error: unknown): UiaChallenge | null {
  if (
    !(error instanceof MatrixError) ||
    !isRecord(error.data) ||
    !('flows' in error.data)
  ) {
    return null;
  }
  const { flows, completed, session }: Record<string, unknown> = error.data;
  return {
    flows: Array.isArray(flows)
      ? flows.map((flow: unknown) => ({
          stages: strings(isRecord(flow) ? flow['stages'] : undefined),
        }))
      : [],
    completed: strings(completed),
    ...(typeof session === 'string' ? { session } : {}),
  };
}

/**
 * An SDK request as the `send` of `driveUia`: the auth goes in as the SDK's dict, a UIA
 * 401 comes back as its challenge, and any other failure is rethrown.
 */
export function jsSdkUia<T>(
  request: (auth: AuthDict | null) => Promise<T>,
): (auth: UiaAuth | null) => Promise<UiaResponse<T>> {
  return async (auth) => {
    try {
      return { kind: 'done', result: await request(auth) };
    } catch (error: unknown) {
      const challenge = uiaChallengeOf(error);
      if (!challenge) throw error;
      return { kind: 'uia-required', challenge };
    }
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
