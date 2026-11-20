/**
 * A sign-in came back as a different account than the one being re-authenticated.
 * Nothing is persisted for it, so the saved account keeps its device and crypto store.
 */
export class ReauthAccountMismatchError extends Error {
  constructor(
    readonly actualUserId: string,
    readonly expectedUserId: string,
  ) {
    super(
      `The server signed you in as ${actualUserId}, not ${expectedUserId}. ` +
        'Sign in to that account instead.',
    );
  }
}

const UNACCEPTABLE_ACCOUNT_MESSAGES = {
  malformed: () =>
    "The server returned an account Trinity can't use. Nothing was saved.",
  'other-server': (userId: string) =>
    `The server signed you in as ${userId}, an account on a different server. ` +
    "Sign in through that account's own server instead.",
  unconfirmed: (userId: string) =>
    `Trinity couldn't confirm that ${userId} belongs to this server. ` +
    "Try again later, or sign in through that account's own server.",
};

/**
 * The server returned an account Trinity will not store: an ID outside the Matrix
 * grammar, or a user ID on a server other than the one signed in to.
 */
export class UnacceptableAccountError extends Error {
  constructor(
    readonly reason: 'malformed' | 'other-server' | 'unconfirmed',
    readonly userId: string,
  ) {
    super(UNACCEPTABLE_ACCOUNT_MESSAGES[reason](userId));
  }
}
