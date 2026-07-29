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

/**
 * Thrown when the server will not accept a password for this action — an SSO-only or
 * OIDC-native account, or a multi-stage flow past the password.
 *
 * A distinct type rather than a bare Error because callers act on it: encryption reset
 * offers the identity provider's own page instead, which is only correct for THIS failure
 * and not for a wrong password or a network error.
 */
export class UiaUnsupportedError extends Error {
  constructor() {
    super(
      'This account needs additional verification that Trinity can’t complete here.',
    );
    this.name = 'UiaUnsupportedError';
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
 * Throws {@link UiaCancelledError} if the prompt is cancelled, and
 * {@link UiaUnsupportedError} when the server requires a stage Trinity can't satisfy
 * here (SSO-only or a multi-stage flow past the password) rather than looping to the
 * attempt cap.
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
      throw new UiaUnsupportedError();
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

/**
 * Rule out a password UIA flow *before* running something that cannot be undone.
 *
 * `probe` must be a harmless request against a UIA-gated endpoint. The server answers it
 * with a 401 listing the stages this user could complete, and the request itself is then
 * abandoned — the flows are the only thing wanted. Throws {@link UiaUnsupportedError}
 * when none of them offers a password, which is what an SSO-only or OIDC-native account
 * looks like.
 *
 * Deliberately silent in every other case, **including when the probe itself fails**.
 * This exists to stop an action that is certain to fail, not to become a new way for one
 * to fail: a dropped connection, or a server that gates the probe differently from the
 * real request, must leave the caller exactly where it was.
 */
export async function assertPasswordUiaAvailable(
  probe: () => Promise<unknown>,
): Promise<void> {
  try {
    await probe();
  } catch (err) {
    const challenge = uiaChallenge(err);
    if (challenge && !offersPassword(challenge)) {
      throw new UiaUnsupportedError();
    }
  }
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
