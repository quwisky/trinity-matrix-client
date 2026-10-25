export type IdentityServerChoice =
  | {
      readonly kind: 'set';
      readonly url: string;
      readonly source: 'account' | 'well-known';
    }
  | { readonly kind: 'off' }
  | { readonly kind: 'none' };

export type IdentityServerRefusal =
  | 'not-https'
  | 'not-identity-server'
  | 'unreachable'
  | 'rate-limited'
  | 'account-unavailable'
  | 'failed';

export interface IdentityServerRefused {
  readonly kind: 'refused';
  readonly reason: IdentityServerRefusal;
  readonly retryAfterMs?: number;
}

export interface IdentityPolicy {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly version: string;
}

export type TermsCheck =
  | { readonly kind: 'accepted' }
  | {
      readonly kind: 'needs-consent';
      readonly policies: readonly IdentityPolicy[];
    }
  | IdentityServerRefused;

export interface PendingPublish {
  readonly accountId: string;
  readonly url: string;
  readonly email: string;
  readonly sid: string;
  readonly clientSecret: string;
  readonly sendAttempt: number;
}

export type PublishLinkResult =
  | { readonly kind: 'sent'; readonly pending: PendingPublish }
  | IdentityServerRefused;

export type PublishResult =
  | { readonly kind: 'published' }
  | { readonly kind: 'not-verified'; readonly pending: PendingPublish }
  | IdentityServerRefused;
