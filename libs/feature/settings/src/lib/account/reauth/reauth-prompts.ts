import type { UiaPasswordPrompt } from '@trinity/util/matrix';

/** The re-authentication screen a dialog shows while a prompt waits for its answer. */
export type ReauthStep =
  | { readonly kind: 'password'; readonly rejected: boolean }
  | {
      readonly kind: 'browser';
      readonly url: string;
      readonly pending: boolean;
    };

/** Bridges the workflow's re-authentication promises to the steps a dialog shows. */
export class ReauthPrompts {
  private passwordAnswer: ((password: string | null) => void) | null = null;
  private browserAnswer: ((finished: boolean) => void) | null = null;

  constructor(private readonly show: (step: ReauthStep) => void) {}

  readonly password: UiaPasswordPrompt = ({ rejected }) =>
    new Promise((resolve) => {
      this.passwordAnswer = resolve;
      this.show({ kind: 'password', rejected });
    });

  readonly confirmInBrowser = ({
    url,
    pending,
  }: {
    readonly url: string;
    readonly pending: boolean;
  }): Promise<boolean> =>
    new Promise((resolve) => {
      this.browserAnswer = resolve;
      this.show({ kind: 'browser', url, pending });
    });

  /** False when no password prompt is waiting. */
  answerPassword(password: string): boolean {
    const answer = this.passwordAnswer;
    this.passwordAnswer = null;
    answer?.(password);
    return answer !== null;
  }

  /** False when no browser prompt is waiting. */
  answerBrowser(finished: boolean): boolean {
    const answer = this.browserAnswer;
    this.browserAnswer = null;
    answer?.(finished);
    return answer !== null;
  }

  /** Resolves waiting prompts as cancelled, so the workflow ends instead of hanging. */
  abandon(): void {
    const password = this.passwordAnswer;
    const browser = this.browserAnswer;
    this.passwordAnswer = null;
    this.browserAnswer = null;
    password?.(null);
    browser?.(false);
  }
}
