import type { UiaPasswordPrompt } from '@trinity/util/matrix';

export interface ContactAddress {
  readonly medium: 'email' | 'msisdn';
  readonly address: string;
}

export type EmailAddressRefusal =
  | 'not-verified'
  | 'in-use'
  | 'cannot-send'
  | 'invalid'
  | 'rate-limited'
  | 'unreachable'
  | 'cancelled'
  | 'attempts-exceeded'
  | 'no-usable-stage'
  | 'account-unavailable'
  | 'failed';

export interface EmailAddressRefused {
  readonly kind: 'refused';
  readonly reason: EmailAddressRefusal;
  readonly retryAfterMs?: number;
}

export type EmailAddressesLoad =
  | {
      readonly kind: 'loaded';
      readonly addresses: readonly ContactAddress[];
      readonly canChange: boolean;
    }
  | EmailAddressRefused;

export interface PendingEmail {
  readonly accountId: string;
  readonly email: string;
  readonly sid: string;
  readonly clientSecret: string;
  readonly sendAttempt: number;
  /** A re-authentication session the server already accepted, reused so the next attempt does not ask again. */
  readonly uiaSession?: string;
}

export type EmailLinkResult =
  | { readonly kind: 'sent'; readonly pending: PendingEmail }
  | EmailAddressRefused;

/** The re-authentication answers the person gives while an address is added. */
export interface EmailAddressStages {
  readonly password: UiaPasswordPrompt;
  /** Resolves true once the person reports the fallback page finished, false to go back. */
  readonly confirmInBrowser: (step: {
    readonly url: string;
    readonly pending: boolean;
  }) => Promise<boolean>;
}

export type EmailAddResult =
  | { readonly kind: 'added' }
  /** The link has not been opened yet; retry with this pending email. */
  | { readonly kind: 'not-verified'; readonly pending: PendingEmail }
  | EmailAddressRefused;

export type EmailRemoveResult =
  { readonly kind: 'removed' } | EmailAddressRefused;
