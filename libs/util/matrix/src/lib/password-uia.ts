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
export interface UiaOutcome<T> {
  readonly result: T;
  /** The password the server accepted, or null when it never asked for one. */
  readonly password: string | null;
}

/** Answers an `m.login.password` stage; `rejected` is true when the previous password was refused. */
export type UiaPasswordPrompt = (context: {
  readonly rejected: boolean;
}) => Promise<string | null>;

/** A stage Trinity completes out of band, through the homeserver's fallback page. */
export interface UiaFallbackStep {
  readonly stage: string;
  readonly session: string;
  /** True when the server still reports this stage incomplete after the person said they finished. */
  readonly pending: boolean;
}

/** Resolves true once the person reports the fallback page finished, false to cancel. */
export type UiaFallback = (step: UiaFallbackStep) => Promise<boolean>;

/** The stages a caller can complete; a stage without a handler makes its flow unusable. */
export interface UiaStages {
  readonly password?: {
    readonly user: string;
    readonly prompt: UiaPasswordPrompt;
  };
  readonly fallback?: UiaFallback;
  readonly replayedAttempts?: number;
}

const PASSWORD_STAGE = 'm.login.password';

/**
 * Drive a request that may require UIA: `makeRequest(null)` probes, then each remaining
 * stage of the first usable flow is completed in turn, in-app for a password and through
 * the fallback page for anything else.
 */
export async function driveUia<T>(
  makeRequest: (auth: AuthDict | null) => Promise<T>,
  stages: UiaStages,
): Promise<UiaOutcome<T>> {
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

  const passwordLimit = MAX_ATTEMPTS + (stages.replayedAttempts ?? 0);
  let passwordAttempts = 0;
  let password: string | null = null;
  let submitted: string | null = null;
  for (;;) {
    if (
      submitted === PASSWORD_STAGE &&
      passwordAttempts >= passwordLimit &&
      !(challenge.completed ?? []).includes(PASSWORD_STAGE)
    ) {
      throw new UiaAttemptsExceededError();
    }
    const stage = nextStage(challenge, stages);
    if (!stage) {
      throw new UiaUnsupportedError();
    }
    const session = challenge.session;
    if (!session) {
      throw new Error('Authentication failed: missing auth session.');
    }
    const pending = submitted === stage;
    let auth: AuthDict;
    if (stage === PASSWORD_STAGE && stages.password) {
      const answer = await stages.password.prompt({ rejected: pending });
      if (answer === null) {
        throw new UiaCancelledError();
      }
      passwordAttempts++;
      password = answer;
      auth = {
        type: PASSWORD_STAGE,
        identifier: { type: 'm.id.user', user: stages.password.user },
        password: answer,
        session,
      };
    } else {
      const finished = await stages.fallback?.({ stage, session, pending });
      if (!finished) {
        throw new UiaCancelledError();
      }
      auth = { session };
    }
    submitted = stage;
    try {
      return { result: await makeRequest(auth), password };
    } catch (err) {
      const next = uiaChallenge(err);
      if (!next) {
        throw err;
      }
      challenge = next;
    }
  }
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
  const { result } = await driveUia(makeRequest, {
    password: { user: userId, prompt: () => promptPassword() },
    replayedAttempts: options?.replayedAttempts,
  });
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
  const { password } = await driveUia(makeRequest, {
    password: { user: userId, prompt: () => promptPassword() },
  });
  return password;
}

/** A UIA 401 carries `flows` + a `session`; return its data, or null. */
function uiaChallenge(err: unknown): UiaData | null {
  const data = err instanceof MatrixError ? err.data : undefined;
  return data && 'flows' in data ? (data as UiaData) : null;
}

/**
 * The next stage to complete: from the first flow finishable in-app, else the first flow
 * whose remaining stages all have a handler. Unknown or empty flows attempt a password.
 */
function nextStage(data: UiaData, stages: UiaStages): string | null {
  const flows = data.flows;
  if (!Array.isArray(flows) || flows.length === 0) {
    return stages.password ? PASSWORD_STAGE : null;
  }
  const completed = data.completed ?? [];
  const remaining = flows
    .map((flow) =>
      Array.isArray(flow.stages)
        ? flow.stages.filter((stage) => !completed.includes(stage))
        : [],
    )
    .filter((rest) => rest.length > 0);
  const inApp = (stage: string) =>
    stage === PASSWORD_STAGE && stages.password !== undefined;
  const usable = (stage: string) =>
    inApp(stage) || stages.fallback !== undefined;
  const flow =
    remaining.find((rest) => rest.every(inApp)) ??
    remaining.find((rest) => rest.every(usable));
  return flow?.[0] ?? null;
}
