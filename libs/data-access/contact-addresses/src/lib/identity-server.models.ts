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
