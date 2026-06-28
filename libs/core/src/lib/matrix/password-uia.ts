import { MatrixError, type AuthDict } from 'matrix-js-sdk';

/** Prompts the user for their password when a UIA stage requires it (null = cancel). */
export type PasswordPrompt = () => Promise<string | null>;

/** Thrown when the user cancels the password prompt during a UIA flow. */
export class UiaCancelledError extends Error {
  constructor() {
    super('Password confirmation was cancelled.');
    this.name = 'UiaCancelledError';
  }
}

/** Max password attempts before giving up on a UIA flow. */
const MAX_ATTEMPTS = 3;

/** The subset of a UIA 401 body we read. */
interface UiaData {
  session?: string;
  flows?: { stages?: string[] }[];
  completed?: string[];
}

/**
 * Drive a request that may require password user-interactive auth (UIA).
 * `makeRequest(null)` probes unauthenticated; on a password challenge the user is
 * prompted and the request retried with an `m.login.password` auth dict,
 * re-prompting on a wrong password up to {@link MAX_ATTEMPTS} times.
 *
 * Throws {@link UiaCancelledError} if the prompt is cancelled, and a clear error
 * when the server requires a stage Trinity can't satisfy here (SSO-only or a
 * multi-stage flow past the password) rather than looping to the attempt cap.
 *
 * Shared by encryption setup (device-signing upload) and device sign-out.
 */
export async function runPasswordUia<T>(
  makeRequest: (auth: AuthDict | null) => Promise<T>,
  promptPassword: PasswordPrompt,
  userId: string,
): Promise<T> {
  // Many servers complete without UIA; a 401 carries the session + flows.
  let challenge: UiaData;
  try {
    return await makeRequest(null);
  } catch (err) {
    const probe = uiaChallenge(err);
    if (!probe) {
      throw err;
    }
    challenge = probe;
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (!offersPassword(challenge)) {
      throw new Error(
        'This account needs additional verification that Trinity can’t complete here.',
      );
    }
    const session = challenge.session;
    if (!session) {
      throw new Error('Authentication failed: missing auth session.');
    }
    const password = await promptPassword();
    if (password === null) {
      throw new UiaCancelledError();
    }
    const auth: AuthDict = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: userId },
      password,
      session,
    };
    try {
      return await makeRequest(auth);
    } catch (err) {
      const next = uiaChallenge(err);
      if (!next) {
        throw err; // a non-UIA failure (network/server) — give up
      }
      challenge = next; // wrong password / next stage — re-prompt
    }
  }
  throw new Error('Too many password attempts.');
}

/** A UIA 401 carries `flows` + a `session`; return its data, or null. */
function uiaChallenge(err: unknown): UiaData | null {
  const data = err instanceof MatrixError ? err.data : undefined;
  return data && 'flows' in data ? (data as UiaData) : null;
}

/**
 * Whether a password stage is still available to complete. Unknown/empty flows
 * fall through to attempting a password (the prior behavior); a flow set that
 * offers only non-password stages (e.g. SSO) returns false so the caller bails.
 */
function offersPassword(data: UiaData): boolean {
  const flows = data.flows;
  if (!Array.isArray(flows) || flows.length === 0) {
    return true;
  }
  const completed = data.completed ?? [];
  return flows.some(
    (flow) =>
      Array.isArray(flow.stages) &&
      flow.stages.includes('m.login.password') &&
      !completed.includes('m.login.password'),
  );
}
