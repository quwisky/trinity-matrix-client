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
 * OIDC-native account, or a multi-stage flow past the password. Distinct because encryption
 * reset offers the identity provider's page for this failure only.
 */
export class UiaUnsupportedError extends Error {
  constructor() {
    super(
      'This account needs additional verification that Trinity can’t complete here.',
    );
    this.name = 'UiaUnsupportedError';
  }
}

/**
 * Thrown when the password was rejected {@link MAX_ATTEMPTS} times. Distinct so a caller
 * authenticating ahead of an irreversible action can tell "the user did not get in" from
 * "the request itself failed"; only the former should stop it.
 */
export class UiaAttemptsExceededError extends Error {
  constructor() {
    super('Too many password attempts.');
    this.name = 'UiaAttemptsExceededError';
  }
}

/**
 * Whether `err` is the UIA flow reporting that the user was *not* authenticated —
 * cancelled, refused by the server, or out of attempts — as opposed to the underlying
 * request failing for its own reasons.
 */
export function isUiaRefusal(err: unknown): boolean {
  return (
    err instanceof UiaCancelledError ||
    err instanceof UiaUnsupportedError ||
    err instanceof UiaAttemptsExceededError
  );
}

/** Max password attempts the *user* gets before we give up on a UIA flow. */
const MAX_ATTEMPTS = 3;

/** Tuning for {@link runPasswordUia}. */
export interface PasswordUiaOptions {
  /**
   * How many of the prompt's first answers are a replayed, previously accepted password
   * rather than the user's. They get their own budget on top of {@link MAX_ATTEMPTS}, so a
   * rejected replay (password changed in between) does not cost the human a try.
   */
  readonly replayedAttempts?: number;
}

/** The subset of a UIA 401 body we read. */
interface UiaData {
  session?: string;
  flows?: { stages?: string[] }[];
  completed?: string[];
}

/** What a completed UIA flow yields: the request's result and the accepted password. */
interface UiaOutcome<T> {
  result: T;
  /** The password the server accepted, or null when it never asked for one. */
  password: string | null;
}

/**
 * Drive a request that may require password UIA: `makeRequest(null)` probes, then a password
 * challenge prompts the user and retries with an `m.login.password` auth dict.
 */
async function drivePasswordUia<T>(
  makeRequest: (auth: AuthDict | null) => Promise<T>,
  promptPassword: PasswordPrompt,
  userId: string,
  { replayedAttempts = 0 }: PasswordUiaOptions = {},
): Promise<UiaOutcome<T>> {
  // Many servers complete without UIA; a 401 carries the session + flows.
  let challenge: UiaData;
  try {
    return { result: await makeRequest(null), password: null };
  } catch (err) {
    const probe = uiaChallenge(err);
    if (!probe) {
      throw err;
    }
    challenge = probe;
  }

  const limit = MAX_ATTEMPTS + replayedAttempts;
  for (let attempt = 0; attempt < limit; attempt++) {
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
      return { result: await makeRequest(auth), password };
    } catch (err) {
      const next = uiaChallenge(err);
      if (!next) {
        throw err; // a non-UIA failure (network/server) — give up
      }
      challenge = next; // wrong password / next stage — re-prompt
    }
  }
  throw new UiaAttemptsExceededError();
}

/**
 * Run `makeRequest` for its result, completing a password UIA flow if the server asks.
 *
 * Throws {@link UiaCancelledError} if the prompt is cancelled, and
 * {@link UiaUnsupportedError} when the server requires a stage Trinity can't satisfy
 * (rather than looping to the attempt cap).
 *
 * Pass {@link PasswordUiaOptions.replayedAttempts} when `promptPassword` answers its first
 * calls from a stored password, so the human still gets the full {@link MAX_ATTEMPTS}.
 */
export async function runPasswordUia<T>(
  makeRequest: (auth: AuthDict | null) => Promise<T>,
  promptPassword: PasswordPrompt,
  userId: string,
  options?: PasswordUiaOptions,
): Promise<T> {
  const { result } = await drivePasswordUia(
    makeRequest,
    promptPassword,
    userId,
    options,
  );
  return result;
}

/**
 * Run the same flow for its *authentication* rather than its result, against a harmless
 * request, and report the accepted password (null if none was asked for).
 *
 * An irreversible action uses this to prove the user can authenticate *before* it starts;
 * the password can then be replayed into the real request's challenge.
 */
export async function completePasswordUia(
  makeRequest: (auth: AuthDict | null) => Promise<unknown>,
  promptPassword: PasswordPrompt,
  userId: string,
): Promise<string | null> {
  const { password } = await drivePasswordUia(
    makeRequest,
    promptPassword,
    userId,
  );
  return password;
}

/** A UIA 401 carries `flows` + a `session`; return its data, or null. */
function uiaChallenge(err: unknown): UiaData | null {
  const data = err instanceof MatrixError ? err.data : undefined;
  return data && 'flows' in data ? (data as UiaData) : null;
}

/**
 * Whether a password stage is still available to complete. Unknown/empty flows attempt a
 * password; a flow set offering only non-password stages (e.g. SSO) returns false.
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
