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
}

export type EmailLinkResult =
  | { readonly kind: 'sent'; readonly pending: PendingEmail }
  | EmailAddressRefused;
