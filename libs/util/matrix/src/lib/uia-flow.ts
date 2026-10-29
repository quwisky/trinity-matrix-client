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

/** Max password attempts the *user* gets before we give up on a UIA flow. */
const MAX_ATTEMPTS = 3;

/** A UIA challenge: the flows the server offers, the stages already done and its session. */
export interface UiaChallenge {
  readonly session?: string;
  readonly flows: readonly { readonly stages: readonly string[] }[];
  readonly completed?: readonly string[];
}

/** The `auth` a request answers a challenge stage with, as the Matrix UIA wire shape. */
export type UiaAuth =
  | {
      readonly type: 'm.login.password';
      readonly identifier: {
        readonly type: 'm.id.user';
        readonly user: string;
      };
      readonly password: string;
      readonly session: string;
    }
  | { readonly session: string };

/** One send of the request: its result, or the challenge the server answered with. */
export type UiaResponse<T> =
  | { readonly kind: 'done'; readonly result: T }
  | { readonly kind: 'uia-required'; readonly challenge: UiaChallenge };

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
  /**
   * How many of the password prompt's first answers are a replayed, previously accepted
   * password rather than the user's. They get their own budget on top of
   * {@link MAX_ATTEMPTS}, so a rejected replay (password changed in between) does not cost
   * the human a try.
   */
  readonly replayedAttempts?: number;
}

const PASSWORD_STAGE = 'm.login.password';

/**
 * Drive a request that may require UIA: `send(null)` probes, then each remaining stage of
 * the first usable flow is completed in turn, in-app for a password and through the
 * fallback page for anything else. A failure `send` throws is rethrown as it is.
 */
export async function driveUia<T>(
  send: (auth: UiaAuth | null) => Promise<UiaResponse<T>>,
  stages: UiaStages,
): Promise<UiaOutcome<T>> {
  let response = await send(null);
  const passwordLimit = MAX_ATTEMPTS + (stages.replayedAttempts ?? 0);
  let passwordAttempts = 0;
  let password: string | null = null;
  let submitted: string | null = null;
  while (response.kind === 'uia-required') {
    const { challenge } = response;
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
    let auth: UiaAuth;
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
    response = await send(auth);
  }
  return { result: response.result, password };
}

/**
 * The next stage to complete: from the first flow finishable in-app, else the first flow
 * whose remaining stages all have a handler. An empty flow set attempts a password.
 */
function nextStage(challenge: UiaChallenge, stages: UiaStages): string | null {
  const { flows } = challenge;
  if (flows.length === 0) {
    return stages.password ? PASSWORD_STAGE : null;
  }
  const completed = challenge.completed ?? [];
  const remaining = flows
    .map((flow) => flow.stages.filter((stage) => !completed.includes(stage)))
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
