export type AccountRestoreFailure =
  'transient-network' | 'corrupt-local-state' | 'crypto-failure';

export type AccountRestoreRole = 'active' | 'inactive';

interface AccountRestoreOutcomeBase {
  readonly accountId: string;
  readonly role: AccountRestoreRole;
  readonly durationMs: number;
}

export type AccountRestoreOutcome =
  | (AccountRestoreOutcomeBase & { readonly kind: 'ready' })
  | (AccountRestoreOutcomeBase & {
      readonly kind: 'reauthentication-required';
    })
  | (AccountRestoreOutcomeBase & { readonly kind: 'timed-out' })
  | (AccountRestoreOutcomeBase & {
      readonly kind: 'failed';
      readonly failure: AccountRestoreFailure;
    });

export interface AccountRestoreMetrics {
  readonly durationMs: number;
  readonly activeTerminalMs: number | null;
  readonly terminalAccounts: number;
  readonly totalAccounts: number;
}

interface AccountRestoreResultBase {
  readonly accounts: readonly AccountRestoreOutcome[];
  readonly metrics: AccountRestoreMetrics;
}

export type AccountRestoreResult =
  | (AccountRestoreResultBase & { readonly kind: 'no-accounts' })
  | (AccountRestoreResultBase & {
      readonly kind: 'local-state-unavailable';
    })
  | (AccountRestoreResultBase & {
      readonly kind: 'restored';
      readonly activeAccountId: string;
    })
  | (AccountRestoreResultBase & {
      readonly kind: 'restored-with-inactive-failures';
      readonly activeAccountId: string;
    })
  | (AccountRestoreResultBase & {
      readonly kind: 'active-account-unavailable';
      readonly activeAccountId: string;
    })
  | (AccountRestoreResultBase & {
      readonly kind: 'transition-in-progress';
      readonly operation: 'establishing-account';
    });

export type AccountEstablishmentPlacement = 'active' | 'inactive';

export type AccountEstablishmentIntent =
  | {
      readonly placement: 'active';
      readonly liveAccounts: 'keep' | 'replace';
      readonly accountRecord: 'upsert' | 'new';
    }
  | {
      readonly placement: 'inactive';
      readonly liveAccounts: 'keep';
      readonly accountRecord: 'upsert' | 'new';
    };

export type AccountEstablishmentFailure =
  | 'account-already-stored'
  | 'active-account-required'
  | 'local-state-unavailable'
  | 'reauthentication-required'
  | 'transient-network'
  | 'crypto-failure';

interface AccountEstablishmentOutcomeBase {
  readonly accountId: string;
  readonly placement: AccountEstablishmentPlacement;
}

export type AccountEstablishmentOutcome =
  | (AccountEstablishmentOutcomeBase & { readonly kind: 'ready' })
  | (AccountEstablishmentOutcomeBase & {
      readonly kind: 'failed';
      readonly failure: AccountEstablishmentFailure;
    })
  | (AccountEstablishmentOutcomeBase & {
      readonly kind: 'transition-in-progress';
    });

export type AccountRuntimeState =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'restoring';
      readonly activeAccountId: string | null;
      readonly totalAccounts: number;
      readonly outcomes: readonly AccountRestoreOutcome[];
    }
  | {
      readonly phase: 'cancelled';
      readonly activeAccountId: string | null;
      readonly totalAccounts: number;
      readonly outcomes: readonly AccountRestoreOutcome[];
    }
  | {
      readonly phase: 'failed';
      readonly activeAccountId: string | null;
      readonly totalAccounts: number;
      readonly outcomes: readonly AccountRestoreOutcome[];
    }
  | { readonly phase: 'settled'; readonly result: AccountRestoreResult }
  | {
      readonly phase: 'establishing';
      readonly accountId: string;
      readonly placement: AccountEstablishmentPlacement;
    }
  | {
      readonly phase: 'establishment-settled';
      readonly outcome: AccountEstablishmentOutcome;
    }
  | {
      readonly phase: 'establishment-cancelled' | 'establishment-failed';
      readonly accountId: string;
      readonly placement: AccountEstablishmentPlacement;
    };
