import type {
  AccountRestoreOutcome,
  AccountRestoreResult,
  AccountRuntimeOperation,
} from './account-runtime.models';
import type { AdapterAccountRestoreOutcome } from './account-runtime.adapter';

export function accountRestoreOutcomeFor(
  accountId: string,
  role: AccountRestoreOutcome['role'],
  outcome: AdapterAccountRestoreOutcome,
): AccountRestoreOutcome {
  return outcome.kind === 'failed'
    ? { ...outcome, accountId, role }
    : { kind: outcome.kind, accountId, role };
}

export function accountRestoreResultFor(
  activeAccountId: string,
  accounts: readonly AccountRestoreOutcome[],
): AccountRestoreResult {
  const active = accounts.find((account) => account.role === 'active')!;
  if (active.kind !== 'ready') {
    return { kind: 'active-account-unavailable', activeAccountId, accounts };
  }
  if (
    accounts.some(
      (account) => account.role === 'inactive' && account.kind !== 'ready',
    )
  ) {
    return {
      kind: 'restored-with-inactive-failures',
      activeAccountId,
      accounts,
    };
  }
  return { kind: 'restored', activeAccountId, accounts };
}

export function emptyAccountRestoreResult(
  kind: 'no-accounts' | 'local-state-unavailable',
): AccountRestoreResult {
  return { kind, accounts: [] };
}

export function accountRestoreTransitionResult(
  operation: AccountRuntimeOperation = 'establishing-account',
): AccountRestoreResult {
  return { kind: 'transition-in-progress', operation, accounts: [] };
}
